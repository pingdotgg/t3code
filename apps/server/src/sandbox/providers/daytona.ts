import { SandboxProviderError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { HttpClientRequest } from "effect/http";
import * as Schema from "effect/Schema";

import {
  authorize,
  type CreatedSandbox,
  jsonBody,
  requestJson,
  type SandboxProviderDriver,
  type SandboxProviderStatus,
} from "../SandboxProvider.ts";

const DAYTONA_API_BASE = "https://app.daytona.io/api";
const POLL_INTERVAL = "2 seconds";
const POLL_ATTEMPTS = 90;

const DaytonaSandbox = Schema.Struct({
  id: Schema.String,
  name: Schema.optionalKey(Schema.NullOr(Schema.String)),
  state: Schema.String,
  errorReason: Schema.optionalKey(Schema.NullOr(Schema.String)),
});

const DaytonaToolboxProxy = Schema.Struct({ url: Schema.String });

const DaytonaPreviewUrl = Schema.Struct({ url: Schema.String });

const DaytonaExecResult = Schema.Struct({
  exitCode: Schema.optionalKey(Schema.Number),
  result: Schema.String,
});

const DaytonaApiKey = Schema.Struct({ organizationId: Schema.String });

const DaytonaUsage = Schema.Struct({
  regionUsage: Schema.Array(
    Schema.Struct({
      totalCpuQuota: Schema.Number,
      currentCpuUsage: Schema.Number,
      totalMemoryQuota: Schema.Number,
      currentMemoryUsage: Schema.Number,
    }),
  ),
});

// CPU and memory (GB) of each snapshot in `info.sizes`, compared against the org's free quota.
const SIZE_RESOURCES: Record<string, { readonly cpu: number; readonly memory: number }> = {
  "daytona-small": { cpu: 1, memory: 1 },
  "daytona-medium": { cpu: 2, memory: 4 },
  "daytona-large": { cpu: 4, memory: 8 },
};

// States missing here (building, resizing, snapshotting, forking, unknown) leave the record alone.
const DAYTONA_STATUS: Record<string, SandboxProviderStatus> = {
  started: "running",
  creating: "starting",
  restoring: "starting",
  starting: "starting",
  pulling_snapshot: "starting",
  resuming: "starting",
  stopped: "stopped",
  stopping: "stopped",
  archived: "stopped",
  archiving: "stopped",
  paused: "stopped",
  pausing: "stopped",
  error: "error",
  build_failed: "error",
  destroyed: "deleted",
  destroying: "deleted",
};

const info = {
  kind: "daytona",
  label: "Daytona",
  detail: "Fast Linux sandboxes with preview URLs for every port.",
  apiKeyLabel: "Daytona API key",
  apiKeyPlaceholder: "dtn_...",
  docsUrl: "https://www.daytona.io/docs/en/api-keys",
  sizes: [
    { id: "daytona-small", label: "Small", detail: "1 vCPU · 1 GB · 3 GB" },
    { id: "daytona-medium", label: "Medium", detail: "2 vCPU · 4 GB · 8 GB" },
    { id: "daytona-large", label: "Large", detail: "4 vCPU · 8 GB · 10 GB" },
  ],
} satisfies SandboxProviderDriver["info"];

const getSandbox = (apiKey: string, sandboxId: string) =>
  requestJson({
    provider: "daytona",
    stage: "start",
    schema: DaytonaSandbox,
    request: authorize(
      HttpClientRequest.get(`${DAYTONA_API_BASE}/sandbox/${encodeURIComponent(sandboxId)}`),
      apiKey,
    ),
  });

const waitUntilStarted = Effect.fn("Daytona.waitUntilStarted")(function* (
  apiKey: string,
  sandboxId: string,
) {
  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
    const sandbox = yield* getSandbox(apiKey, sandboxId);
    if (sandbox.state === "started") return sandbox;
    if (sandbox.state === "error" || sandbox.state === "build_failed") {
      return yield* new SandboxProviderError({
        provider: "daytona",
        stage: "start",
        detail: `The sandbox entered the ${sandbox.state} state while starting.`,
        ...(sandbox.errorReason === undefined || sandbox.errorReason === null
          ? {}
          : { cause: new Error(sandbox.errorReason) }),
      });
    }
    if (attempt < POLL_ATTEMPTS - 1) yield* Effect.sleep(POLL_INTERVAL);
  }
  return yield* new SandboxProviderError({
    provider: "daytona",
    stage: "start",
    detail: "Timed out waiting for the sandbox to start.",
  });
});

const toolboxBaseUrl = (apiKey: string, sandboxId: string) =>
  requestJson({
    provider: "daytona",
    stage: "install",
    schema: DaytonaToolboxProxy,
    request: authorize(
      HttpClientRequest.get(
        `${DAYTONA_API_BASE}/sandbox/${encodeURIComponent(sandboxId)}/toolbox-proxy-url`,
      ),
      apiKey,
    ),
  }).pipe(Effect.map((proxy) => `${proxy.url.replace(/\/+$/, "")}/${sandboxId}`));

export const daytonaDriver: SandboxProviderDriver = {
  info,
  defaultSize: "daytona-medium",
  serverPort: 3773,
  create: (input) =>
    requestJson({
      provider: "daytona",
      stage: "create",
      schema: DaytonaSandbox,
      request: jsonBody(
        authorize(HttpClientRequest.post(`${DAYTONA_API_BASE}/sandbox`), input.config.apiKey),
        {
          name: input.name,
          snapshot: input.size,
          public: true,
          autoStopInterval: 0,
          autoDeleteInterval: -1,
          // Daytona's `ttlMinutes` destroys the sandbox, disk included, so it lands a day after
          // T3's own deadline stop and only cleans up when T3 never got to act.
          ...(input.ttlMinutes === undefined ? {} : { ttlMinutes: input.ttlMinutes + 1440 }),
          labels: { "t3.code/role": "environment" },
        },
      ),
    }).pipe(
      Effect.flatMap((sandbox) =>
        // Daytona is created with auto-stop and auto-delete disabled, so a machine that never
        // finishes starting would bill forever if the provisioner never learned its id.
        waitUntilStarted(input.config.apiKey, sandbox.id).pipe(
          Effect.onExit((exit) =>
            Exit.isSuccess(exit)
              ? Effect.void
              : daytonaDriver
                  .destroy({ config: input.config, sandboxId: sandbox.id })
                  .pipe(Effect.ignore),
          ),
        ),
      ),
      Effect.map((sandbox): CreatedSandbox => ({
        id: sandbox.id,
        name: sandbox.name ?? input.name,
      })),
    ),
  limits: Effect.fn("Daytona.limits")(
    function* (input) {
      const key = yield* requestJson({
        provider: "daytona",
        stage: "config",
        schema: DaytonaApiKey,
        request: authorize(
          HttpClientRequest.get(`${DAYTONA_API_BASE}/api-keys/current`),
          input.config.apiKey,
        ),
      });
      const usage = yield* requestJson({
        provider: "daytona",
        stage: "config",
        schema: DaytonaUsage,
        request: authorize(
          HttpClientRequest.get(
            `${DAYTONA_API_BASE}/organizations/${encodeURIComponent(key.organizationId)}/usage`,
          ),
          input.config.apiKey,
        ),
      });
      return {
        canStart: true,
        sizes: info.sizes.map((size) => {
          const needs = SIZE_RESOURCES[size.id];
          const fits =
            needs === undefined ||
            usage.regionUsage.length === 0 ||
            usage.regionUsage.some(
              (region) =>
                region.totalCpuQuota - region.currentCpuUsage >= needs.cpu &&
                region.totalMemoryQuota - region.currentMemoryUsage >= needs.memory,
            );
          return fits
            ? { id: size.id, available: true }
            : { id: size.id, available: false, reason: "Not enough CPU or memory quota left." };
        }),
      };
    },
    // Keys scoped to sandboxes only cannot read the organization's usage; that is "unknown".
    Effect.catchIf(
      (error) => error.status === 401 || error.status === 403,
      () => Effect.succeed(null),
    ),
  ),
  execute: Effect.fn("Daytona.execute")(function* (input) {
    const baseUrl = yield* toolboxBaseUrl(input.config.apiKey, input.sandboxId);
    const result = yield* requestJson({
      provider: "daytona",
      stage: "install",
      schema: DaytonaExecResult,
      request: jsonBody(
        authorize(HttpClientRequest.post(`${baseUrl}/process/execute`), input.config.apiKey),
        {
          command: input.command,
          timeout: Math.min(Math.max(input.timeoutSeconds, 1), 600),
        },
      ),
    });
    const exitCode = result.exitCode ?? 0;
    if (exitCode !== 0) {
      return yield* new SandboxProviderError({
        provider: "daytona",
        stage: "install",
        // Only the exit status is an attribute; command output can contain secrets.
        detail: `The command exited with ${exitCode}.`,
        cause: new Error(result.result.trim().slice(-4000)),
      });
    }
    return { exitCode, stdout: result.result, stderr: "" };
  }),
  exposePort: (input) =>
    requestJson({
      provider: "daytona",
      stage: "expose",
      schema: DaytonaPreviewUrl,
      request: authorize(
        HttpClientRequest.get(
          `${DAYTONA_API_BASE}/sandbox/${encodeURIComponent(input.sandboxId)}/ports/${input.port}/preview-url`,
        ),
        input.config.apiKey,
      ),
    }).pipe(Effect.map((preview) => preview.url)),
  stop: (input) =>
    requestJson({
      provider: "daytona",
      stage: "delete",
      schema: Schema.Struct({ id: Schema.optionalKey(Schema.String) }),
      request: authorize(
        HttpClientRequest.post(
          `${DAYTONA_API_BASE}/sandbox/${encodeURIComponent(input.sandboxId)}/stop`,
        ),
        input.config.apiKey,
      ),
    }).pipe(Effect.asVoid),
  resume: (input) =>
    requestJson({
      provider: "daytona",
      stage: "start",
      schema: DaytonaSandbox,
      request: authorize(
        HttpClientRequest.post(
          `${DAYTONA_API_BASE}/sandbox/${encodeURIComponent(input.sandboxId)}/start`,
        ),
        input.config.apiKey,
      ),
    }).pipe(
      Effect.flatMap((sandbox) => waitUntilStarted(input.config.apiKey, sandbox.id)),
      Effect.map(() => ({})),
    ),
  status: (input) =>
    getSandbox(input.config.apiKey, input.sandboxId).pipe(
      Effect.map((sandbox) => DAYTONA_STATUS[sandbox.state] ?? null),
      Effect.catchIf(
        (error) => error.code === "not_found",
        () => Effect.succeed("deleted" as const),
      ),
    ),
  destroy: (input) =>
    requestJson({
      provider: "daytona",
      stage: "delete",
      schema: Schema.Struct({ id: Schema.optionalKey(Schema.String) }),
      request: authorize(
        HttpClientRequest.delete(
          `${DAYTONA_API_BASE}/sandbox/${encodeURIComponent(input.sandboxId)}`,
        ),
        input.config.apiKey,
      ),
    }).pipe(Effect.asVoid),
};
