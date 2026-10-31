import { type SandboxProviderLimits, SandboxProviderError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { HttpClientRequest } from "effect/http";
import * as Schema from "effect/Schema";

import {
  authorize,
  type CreatedSandbox,
  jsonBody,
  requestJson,
  type SandboxProviderDriver,
  type SandboxProviderStatus,
  type SandboxUsage,
  shellQuote,
} from "../SandboxProvider.ts";

const BOAT_API_BASE = "https://boat.dev/api/v1";
const BOAT_BILLING_URL = "https://boat.dev/dashboard?tab=billing";
// Trial accounts must auto-stop within two hours (`400 trial_auto_stop_required`).
const TRIAL_MAX_TTL_MINUTES = 120;
const MAX_TTL_MINUTES = 43200;
// Tags every sandbox T3 creates, so one filtered list call can read all their costs.
const ROLE_LABEL = { key: "t3.code/role", value: "environment" } as const;

const BoatSandbox = Schema.Struct({
  sandbox: Schema.Struct({
    id: Schema.String,
    name: Schema.optionalKey(Schema.String),
  }),
  hostedPorts: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        port: Schema.Number,
        url: Schema.optionalKey(Schema.String),
      }),
    ),
  ),
});

const BoatCommand = Schema.Struct({
  exitCode: Schema.NullOr(Schema.Number),
  stdout: Schema.String,
  stderr: Schema.String,
});

const BoatHostedPort = Schema.Struct({ url: Schema.String });

const BoatLifecycle = Schema.Struct({
  sandbox: Schema.Struct({
    id: Schema.String,
    state: Schema.String,
    error: Schema.optionalKey(Schema.NullOr(Schema.String)),
    dataExpiredAt: Schema.optionalKey(Schema.NullOr(Schema.String)),
  }),
});

const BoatCostList = Schema.Struct({
  sandboxes: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      cost: Schema.optionalKey(
        Schema.NullOr(Schema.Struct({ since: Schema.String, dollars: Schema.Number })),
      ),
    }),
  ),
});

const BOAT_STATUS: Record<string, SandboxProviderStatus> = {
  ready: "running",
  idle: "running",
  running: "running",
  init: "starting",
  provisioning: "starting",
  provisioned: "starting",
  cloning: "starting",
  archiving: "starting",
  archived: "stopped",
  error: "error",
  cancelled: "deleted",
};

const BoatStartWindow = Schema.NullOr(
  Schema.Struct({ limit: Schema.Number, used: Schema.Number, remaining: Schema.Number }),
);

// `/limits` returns dozens of plan, wallet, and upgrade fields; only these feed the preflight.
const BoatLimits = Schema.Struct({
  canStart: Schema.Boolean,
  startBlockedReason: Schema.optionalKey(Schema.NullOr(Schema.String)),
  blockedReason: Schema.optionalKey(Schema.NullOr(Schema.String)),
  checkoutRequired: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
  accessTier: Schema.optionalKey(Schema.NullOr(Schema.String)),
  sandboxPlanKey: Schema.optionalKey(Schema.NullOr(Schema.String)),
  sandboxPlanDollars: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  activeSandboxes: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  maxActiveSandboxes: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  nextStartDollars: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  starts: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        minute: Schema.optionalKey(BoatStartWindow),
        hour: Schema.optionalKey(BoatStartWindow),
        day: Schema.optionalKey(BoatStartWindow),
      }),
    ),
  ),
  startWindowFull: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        window: Schema.optionalKey(Schema.NullOr(Schema.String)),
        freesAt: Schema.optionalKey(Schema.NullOr(Schema.String)),
      }),
    ),
  ),
  machineTypes: Schema.optionalKey(
    Schema.NullOr(
      Schema.Array(
        Schema.Struct({
          type: Schema.String,
          available: Schema.Boolean,
          reason: Schema.optionalKey(Schema.NullOr(Schema.String)),
        }),
      ),
    ),
  ),
});

const boundedText = (value: string | null | undefined) => {
  const trimmed = value?.trim() ?? "";
  return trimmed === "" ? undefined : trimmed.slice(0, 300);
};

const toLimits = (raw: typeof BoatLimits.Type): SandboxProviderLimits => {
  const isTrial = raw.accessTier === "trial" || raw.sandboxPlanKey === "trial";
  const blockedReason = boundedText(raw.startBlockedReason) ?? boundedText(raw.blockedReason);
  const starts = (["minute", "hour", "day"] as const).flatMap((window) => {
    const entry = raw.starts?.[window];
    if (entry === undefined || entry === null) return [];
    const freesAt = raw.startWindowFull?.window === window ? raw.startWindowFull.freesAt : null;
    return [
      {
        window,
        limit: entry.limit,
        used: entry.used,
        remaining: entry.remaining,
        ...(freesAt ? { resetsAt: freesAt } : {}),
      },
    ];
  });
  const plan = isTrial
    ? "Trial"
    : typeof raw.sandboxPlanDollars === "number" && raw.sandboxPlanDollars > 0
      ? `$${raw.sandboxPlanDollars} plan`
      : boundedText(raw.accessTier);
  return {
    canStart: raw.canStart,
    ...(blockedReason === undefined ? {} : { blockedReason }),
    ...(starts.length === 0 ? {} : { starts }),
    ...(typeof raw.activeSandboxes === "number" && typeof raw.maxActiveSandboxes === "number"
      ? { concurrency: { active: raw.activeSandboxes, max: raw.maxActiveSandboxes } }
      : {}),
    // Boat's own encoding: 0 is inside the plan, more is a paid burst, null is a refusal.
    ...(raw.nextStartDollars === undefined
      ? {}
      : raw.nextStartDollars === null
        ? { startCost: "refused" as const }
        : raw.nextStartDollars > 0
          ? { startCost: "paid" as const, startDollars: raw.nextStartDollars }
          : { startCost: "included" as const }),
    maxTtlMinutes: isTrial ? TRIAL_MAX_TTL_MINUTES : MAX_TTL_MINUTES,
    ...(raw.machineTypes === undefined || raw.machineTypes === null
      ? {}
      : {
          sizes: raw.machineTypes.map((machine) => {
            const reason = boundedText(machine.reason);
            return {
              id: machine.type,
              available: machine.available,
              ...(reason === undefined ? {} : { reason }),
            };
          }),
        }),
    ...(plan === undefined ? {} : { plan }),
    ...(raw.checkoutRequired === true || !raw.canStart ? { billingUrl: BOAT_BILLING_URL } : {}),
  };
};

// Only flags, never `envContents` or `secretFiles`: those hold real credential values and must
// not leave the server that owns the provider key.
const BoatEnvironment = Schema.Struct({
  name: Schema.String,
  isDefault: Schema.Boolean,
  safeForThirdParties: Schema.Boolean,
  passGithub: Schema.Boolean,
  passSecrets: Schema.Boolean,
  passSandboxCredentials: Schema.Boolean,
  passAgentsCredentials: Schema.Boolean,
  proxyAiCredentials: Schema.Boolean,
});

const BoatEnvironments = Schema.Struct({
  environments: Schema.Array(BoatEnvironment),
});

const info = {
  kind: "boat",
  label: "Boat",
  detail: "Full Ubuntu VMs with a public HTTPS URL per port.",
  apiKeyLabel: "Boat API key",
  apiKeyPlaceholder: "boat_...",
  docsUrl: "https://docs.boat.dev/api-keys",
  sizes: [
    { id: "small", label: "Small", detail: "2 vCPU · 4 GB · 51 GB" },
    { id: "default", label: "Default", detail: "4 vCPU · 8 GB · 51 GB" },
    { id: "large", label: "Large", detail: "8 vCPU · 16 GB · 111 GB" },
    { id: "xlarge", label: "Extra large", detail: "16 vCPU · 32 GB · 251 GB" },
  ],
} satisfies SandboxProviderDriver["info"];

export const boatDriver: SandboxProviderDriver = {
  info,
  defaultSize: "default",
  serverPort: 3773,
  create: Effect.fn("Boat.create")(function* (input) {
    const created = yield* requestJson({
      provider: "boat",
      stage: "create",
      schema: BoatSandbox,
      request: jsonBody(
        HttpClientRequest.setHeaders(
          authorize(HttpClientRequest.post(`${BOAT_API_BASE}/sandboxes`), input.config.apiKey),
          { "Idempotency-Key": input.idempotencyKey },
        ),
        {
          name: input.name,
          type: input.size,
          // A sandbox created by T3 must never inherit the account's GitHub token,
          // secrets, or agent logins by default. Credentials are opt-in per environment.
          ...(input.environment === undefined
            ? { noEnv: true }
            : { environment: input.environment }),
          // A paired environment is meant to outlive the setup session, so the provider's auto-stop
          // must never fire before T3's own lifetime limit (eight hours by default).
          ttlSeconds: (input.ttlMinutes ?? 480) * 60,
          labels: { [ROLE_LABEL.key]: ROLE_LABEL.value },
          // `localhost` keeps the port reachable whether t3 binds 0.0.0.0 or the
          // background service's loopback default.
          hostedPorts: [{ port: 3773, public: true, localhost: true, title: "T3 Code" }],
        },
      ),
    });
    const url = created.hostedPorts?.find((port) => port.port === 3773)?.url;
    return {
      id: created.sandbox.id,
      name: created.sandbox.name ?? input.name,
      ...(url === undefined ? {} : { publicUrl: url }),
    } satisfies CreatedSandbox;
  }),
  limits: (input) =>
    requestJson({
      provider: "boat",
      stage: "config",
      schema: BoatLimits,
      request: authorize(HttpClientRequest.get(`${BOAT_API_BASE}/limits`), input.config.apiKey),
    }).pipe(Effect.map(toLimits)),
  listEnvironments: Effect.fn("Boat.listEnvironments")(function* (input) {
    const listed = yield* requestJson({
      provider: "boat",
      stage: "config",
      schema: BoatEnvironments,
      request: authorize(
        HttpClientRequest.get(`${BOAT_API_BASE}/environments`),
        input.config.apiKey,
      ),
    });
    return listed.environments;
  }),
  execute: (input) =>
    requestJson({
      provider: "boat",
      stage: "install",
      schema: BoatCommand,
      request: jsonBody(
        authorize(
          HttpClientRequest.post(
            `${BOAT_API_BASE}/sandboxes/${encodeURIComponent(input.sandboxId)}/commands`,
          ),
          input.config.apiKey,
        ),
        {
          // An `exit` in Boat's login shell runs ~/.bash_logout (clear_console), which fails it.
          command: `sh -c ${shellQuote(input.command)}`,
          timeoutSeconds: Math.min(Math.max(input.timeoutSeconds, 1), 600),
        },
      ),
    }).pipe(
      Effect.filterOrFail(
        (result) => result.exitCode === 0,
        (result) =>
          new SandboxProviderError({
            provider: "boat",
            stage: "install",
            // Only the exit status is an attribute. The raw output can contain secrets, so it is
            // kept in the cause for diagnostics and never shown to the client or logged.
            detail: `The command exited with ${result.exitCode ?? "an unknown status"}.`,
            cause: new Error(
              [result.stderr, result.stdout]
                .map((part) => part.trim())
                .filter((part) => part !== "")
                .join("\n")
                .slice(-4000),
            ),
          }),
      ),
      Effect.map((result) => ({ ...result, exitCode: result.exitCode ?? 0 })),
    ),
  exposePort: (input) =>
    requestJson({
      provider: "boat",
      stage: "expose",
      schema: BoatHostedPort,
      request: jsonBody(
        authorize(
          HttpClientRequest.post(
            `${BOAT_API_BASE}/sandboxes/${encodeURIComponent(input.sandboxId)}/host`,
          ),
          input.config.apiKey,
        ),
        { port: input.port, public: true },
      ),
    }).pipe(Effect.map((result) => result.url)),
  stop: (input) =>
    requestJson({
      provider: "boat",
      stage: "delete",
      schema: Schema.Struct({ ok: Schema.optionalKey(Schema.Boolean) }),
      request: authorize(
        HttpClientRequest.post(
          `${BOAT_API_BASE}/sandboxes/${encodeURIComponent(input.sandboxId)}/stop`,
        ),
        input.config.apiKey,
      ),
    }).pipe(Effect.asVoid),
  resume: Effect.fn("Boat.resume")(function* (input) {
    yield* requestJson({
      provider: "boat",
      stage: "start",
      schema: Schema.Struct({ ok: Schema.optionalKey(Schema.Boolean) }),
      request: jsonBody(
        authorize(
          HttpClientRequest.post(
            `${BOAT_API_BASE}/sandboxes/${encodeURIComponent(input.sandboxId)}/resume`,
          ),
          input.config.apiKey,
        ),
        input.ttlMinutes === undefined ? {} : { ttlSeconds: input.ttlMinutes * 60 },
      ),
    });
    for (let attempt = 0; attempt < 90; attempt++) {
      const current = yield* requestJson({
        provider: "boat",
        stage: "start",
        schema: BoatLifecycle,
        request: authorize(
          HttpClientRequest.get(
            `${BOAT_API_BASE}/sandboxes/${encodeURIComponent(input.sandboxId)}`,
          ),
          input.config.apiKey,
        ),
      });
      const state = current.sandbox.state;
      if (state === "ready" || state === "idle" || state === "running") return {};
      if (state === "error" || state === "archived") {
        return yield* new SandboxProviderError({
          provider: "boat",
          stage: "start",
          detail: current.sandbox.error?.trim() || `The sandbox stayed ${state}.`,
        });
      }
      if (attempt < 89) yield* Effect.sleep("2 seconds");
    }
    return yield* new SandboxProviderError({
      provider: "boat",
      stage: "start",
      detail: "Timed out waiting for the sandbox to resume.",
    });
  }),
  // Boat's TTL is an auto-stop counted from create or resume, so a stopped sandbox gets the remaining
  // time when it resumes and only a running one needs it moved now. PATCH sets now + ttlSeconds.
  extend: (input) =>
    input.running
      ? requestJson({
          provider: "boat",
          stage: "config",
          schema: Schema.Struct({ ok: Schema.optionalKey(Schema.Boolean) }),
          request: jsonBody(
            authorize(
              HttpClientRequest.patch(
                `${BOAT_API_BASE}/sandboxes/${encodeURIComponent(input.sandboxId)}`,
              ),
              input.config.apiKey,
            ),
            { ttlSeconds: input.ttlMinutes * 60 },
          ),
        }).pipe(Effect.asVoid)
      : Effect.void,
  status: (input) =>
    requestJson({
      provider: "boat",
      stage: "start",
      schema: BoatLifecycle,
      request: authorize(
        HttpClientRequest.get(`${BOAT_API_BASE}/sandboxes/${encodeURIComponent(input.sandboxId)}`),
        input.config.apiKey,
      ),
    }).pipe(
      Effect.map(({ sandbox }): SandboxProviderStatus | null =>
        // Boat drops a stopped sandbox's disk 14 days after the stop; resume then fails.
        sandbox.state === "archived" && sandbox.dataExpiredAt
          ? "expired"
          : (BOAT_STATUS[sandbox.state] ?? null),
      ),
      Effect.catchIf(
        (error) => error.code === "not_found",
        () => Effect.succeed("deleted" as const),
      ),
    ),
  usage: (input) =>
    requestJson({
      provider: "boat",
      stage: "config",
      schema: BoatCostList,
      request: authorize(
        HttpClientRequest.get(`${BOAT_API_BASE}/sandboxes`).pipe(
          HttpClientRequest.setUrlParams({
            include: "cost",
            label: `${ROLE_LABEL.key}=${ROLE_LABEL.value}`,
            limit: "200",
          }),
        ),
        input.config.apiKey,
      ),
    }).pipe(
      Effect.map(
        (listed) =>
          new Map(
            listed.sandboxes.flatMap((sandbox): Array<[string, SandboxUsage]> =>
              sandbox.cost === undefined || sandbox.cost === null
                ? []
                : [[sandbox.id, { dollars: sandbox.cost.dollars, since: sandbox.cost.since }]],
            ),
          ),
      ),
    ),
  destroy: (input) => {
    const request = HttpClientRequest.delete(
      `${BOAT_API_BASE}/sandboxes/${encodeURIComponent(input.sandboxId)}`,
    );
    return requestJson({
      provider: "boat",
      stage: "delete",
      schema: Schema.Struct({ ok: Schema.optionalKey(Schema.Boolean) }),
      request: HttpClientRequest.setHeaders(authorize(request, input.config.apiKey), {
        "X-Ascii-Confirm-Delete": input.sandboxId,
      }),
    }).pipe(Effect.asVoid);
  },
};
