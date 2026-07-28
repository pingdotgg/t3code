import {
  HermesCronError,
  type HermesCronCapabilities,
  type HermesCronExecution,
  type HermesCronJob,
  type HermesCronListResult,
  type HermesCronMutationInput,
  type HermesCronMutationResponse,
  type HermesCronProviderProjection,
  type HermesGatewayCompatibility,
  type HermesGatewayCronJob,
  type HermesGatewayCronListResult,
  type HermesGatewayCronMutationResult,
} from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ServerSettings from "../serverSettings.ts";
import {
  HermesGatewayClient,
  HermesGatewayConfigurationError,
  HermesGatewayDuplicateOperationIdError,
  HermesGatewayMutationIndeterminateError,
  HermesGatewayMutationsBlockedError,
  type HermesGatewayMutationOptions,
  type HermesGatewayReadOptions,
} from "./HermesGatewayClient.ts";
import {
  hermesManageActionInventory,
  resolveHermesProviderConnections,
  type HermesProviderConnection,
} from "./HermesProviderDirectory.ts";

interface HermesCronGatewayClient {
  readonly compatibility: HermesGatewayCompatibility | undefined;
  connect(): Promise<HermesGatewayCompatibility>;
  hasCapability(capability: string): boolean;
  listCronJobs(
    options?: Omit<HermesGatewayReadOptions, "requiredCapability">,
  ): Promise<HermesGatewayCronListResult>;
  manageCron(
    params: Record<string, unknown>,
    options: Omit<HermesGatewayMutationOptions, "requiredCapability">,
  ): Promise<HermesGatewayCronMutationResult>;
  close(): void;
}

type HermesCronProviderConfig = HermesProviderConnection;

export interface HermesCronOptions {
  readonly clientFactory?: (input: {
    readonly endpoint: string;
    readonly authToken: string;
  }) => HermesCronGatewayClient;
}

export interface HermesCronShape {
  readonly list: () => Effect.Effect<HermesCronListResult, HermesCronError>;
  readonly mutate: (
    input: HermesCronMutationInput,
  ) => Effect.Effect<HermesCronMutationResponse, HermesCronError>;
}

export class HermesCron extends Context.Service<HermesCron, HermesCronShape>()(
  "t3/hermes/HermesCron",
) {}

const isHermesCronError = Schema.is(HermesCronError);
const digest = (value: unknown): string =>
  NodeCrypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const string = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;
const stringOrNumber = (value: unknown): string | number | undefined =>
  typeof value === "string" || typeof value === "number" ? value : undefined;

export function projectHermesCronCapabilities(
  compatibility: HermesGatewayCompatibility,
): HermesCronCapabilities {
  if (compatibility.status === "unsupported") {
    return {
      inventory: false,
      create: false,
      edit: false,
      pause: false,
      resume: false,
      delete: false,
      runNow: false,
    };
  }
  const capabilities = new Set(compatibility.capabilities);
  // The gateway client only accepts cron.read for list and cron.manage for
  // mutations, so the projection must not enable operations from granular
  // aliases or legacy status that the client would reject.
  const manage = capabilities.has("cron.manage");
  const inventoried = hermesManageActionInventory(compatibility, "cron.manage");
  // Pinned legacy gateways have no negotiated action inventory; only the
  // evidenced list/add/remove operations are enabled for them.
  const actions =
    inventoried.size > 0
      ? inventoried
      : compatibility.status === "legacy"
        ? new Set(["add", "remove"])
        : inventoried;
  const allows = (...names: ReadonlyArray<string>) =>
    manage && (actions.size === 0 || names.some((name) => actions.has(name)));
  return {
    inventory: capabilities.has("cron.read"),
    create: allows("add", "create"),
    edit: allows("update", "edit"),
    pause: allows("pause"),
    resume: allows("resume"),
    delete: allows("remove", "delete"),
    runNow: allows("run", "run_now", "run-now"),
  };
}

function projectExecution(
  input: {
    readonly providerInstanceId: string;
    readonly profileKey: string;
    readonly jobIdentity: string;
  },
  value: unknown,
): HermesCronExecution | null {
  const row = record(value);
  if (!row) return null;
  const upstreamRunId = string(row.run_id) ?? string(row.id) ?? null;
  const upstreamCursor = stringOrNumber(row.cursor) ?? stringOrNumber(row.sequence) ?? null;
  const startedAt =
    stringOrNumber(row.started_at) ??
    stringOrNumber(row.startedAt) ??
    stringOrNumber(row.created_at) ??
    null;
  const completedAt =
    stringOrNumber(row.completed_at) ??
    stringOrNumber(row.completedAt) ??
    stringOrNumber(row.finished_at) ??
    null;
  const status = string(row.status) ?? null;
  const stableFields = {
    jobIdentity: input.jobIdentity,
    upstreamRunId,
    upstreamCursor,
    startedAt,
    completedAt,
    status,
  };
  return {
    dedupeKey: upstreamRunId
      ? `hermes-run:${upstreamRunId}`
      : `hermes-derived:${digest(stableFields)}`,
    status,
    startedAt,
    completedAt,
    provenance: {
      scheduler: "hermes",
      providerInstanceId: input.providerInstanceId,
      profileKey: input.profileKey,
      jobIdentity: input.jobIdentity,
      upstreamRunId,
      upstreamCursor,
      identityStrength: upstreamRunId || upstreamCursor !== null ? "upstream" : "derived",
    },
  };
}

export function projectHermesCronJob(
  providerInstanceId: string,
  profileKey: string,
  job: HermesGatewayCronJob,
  ordinal: number,
): HermesCronJob {
  const id = job.id?.trim() || null;
  const name = job.name?.trim() || null;
  const identity = id ?? name ?? `unaddressable:${digest([job.schedule, job.prompt, ordinal])}`;
  const executionRows = job.executions ?? job.runs ?? job.history ?? [];
  const deduped = new Map<string, HermesCronExecution>();
  for (const value of executionRows) {
    const projected = projectExecution(
      { providerInstanceId, profileKey, jobIdentity: identity },
      value,
    );
    if (projected) deduped.set(projected.dedupeKey, projected);
  }
  return {
    identity,
    identityStrength: id ? "id" : name ? "name" : "missing",
    id,
    name,
    schedule: job.schedule ?? null,
    prompt: job.prompt ?? null,
    enabled: job.enabled ?? (job.paused === undefined ? null : !job.paused),
    nextRunAt: job.next_run_at ?? null,
    lastRunAt: job.last_run_at ?? null,
    executions: [...deduped.values()],
  };
}

function projectProvider(input: {
  readonly config: HermesCronProviderConfig;
  readonly compatibility: HermesGatewayCompatibility;
  readonly result: HermesGatewayCronListResult;
}): HermesCronProviderProjection {
  if (!input.result.success) {
    return {
      providerInstanceId: input.config.providerInstanceId,
      displayName: input.config.displayName,
      profileKey: input.config.profileKey,
      status: "error",
      protocolClassification: input.compatibility.status,
      capabilities: projectHermesCronCapabilities(input.compatibility),
      jobs: [],
      diagnostics: ["Hermes gateway reported an unsuccessful cron inventory response."],
    };
  }
  const diagnostics: string[] = [];
  const jobs = input.result.jobs.map((job, index) =>
    projectHermesCronJob(input.config.providerInstanceId, input.config.profileKey, job, index),
  );
  const missingIdentity = jobs.filter((job) => job.identityStrength === "missing").length;
  if (missingIdentity > 0) {
    diagnostics.push(
      `${missingIdentity} cron job(s) have no upstream id or name and cannot be safely mutated.`,
    );
  }
  if (!jobs.some((job) => job.executions.some((run) => run.provenance.upstreamCursor !== null))) {
    diagnostics.push("Hermes does not expose a durable global cron execution cursor.");
  }
  if (input.compatibility.status === "legacy") {
    diagnostics.push(
      "Gateway capabilities are not negotiated; only pinned list/add/remove operations are enabled.",
    );
  }
  return {
    providerInstanceId: input.config.providerInstanceId,
    displayName: input.config.displayName,
    profileKey: input.config.profileKey,
    status: "ready",
    protocolClassification: input.compatibility.status,
    capabilities: projectHermesCronCapabilities(input.compatibility),
    jobs,
    diagnostics,
  };
}

const unavailableProjection = (
  providerInstanceId: string,
  displayName: string,
  profileKey: string,
  diagnostic: string,
  status: "unavailable" | "error" = "unavailable",
): HermesCronProviderProjection => ({
  providerInstanceId,
  displayName,
  profileKey,
  status,
  protocolClassification: null,
  capabilities: {
    inventory: false,
    create: false,
    edit: false,
    pause: false,
    resume: false,
    delete: false,
    runNow: false,
  },
  jobs: [],
  diagnostics: [diagnostic],
});

function mutationCapability(
  capabilities: HermesCronCapabilities,
  operation: HermesCronMutationInput["operation"],
): boolean {
  switch (operation) {
    case "create":
      return capabilities.create;
    case "edit":
      return capabilities.edit;
    case "pause":
      return capabilities.pause;
    case "resume":
      return capabilities.resume;
    case "delete":
      return capabilities.delete;
    case "run_now":
      return capabilities.runNow;
  }
}

function mutationParams(input: HermesCronMutationInput): Record<string, unknown> {
  switch (input.operation) {
    case "create":
      return { action: "add", name: input.name, schedule: input.schedule, prompt: input.prompt };
    case "edit":
      return {
        action: "update",
        name: input.jobIdentity,
        ...(input.name === undefined ? {} : { new_name: input.name }),
        ...(input.schedule === undefined ? {} : { schedule: input.schedule }),
        ...(input.prompt === undefined ? {} : { prompt: input.prompt }),
      };
    case "pause":
      return { action: "pause", name: input.jobIdentity };
    case "resume":
      return { action: "resume", name: input.jobIdentity };
    case "delete":
      return { action: "remove", name: input.jobIdentity };
    case "run_now":
      return { action: "run", name: input.jobIdentity };
  }
}

export const makeHermesCron = Effect.fn("HermesCron.make")(function* (
  options: HermesCronOptions = {},
) {
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const clientFactory =
    options.clientFactory ??
    ((input: { readonly endpoint: string; readonly authToken: string }) =>
      new HermesGatewayClient(input));
  // Clients are shared per connection so mutation operationId fences survive
  // across cron calls instead of dying with a per-call client. The fence only
  // has to survive for the same connection identity: when an instance's
  // endpoint or token changes, the superseded client is closed and evicted so
  // stale connections do not accumulate.
  const clients = new Map<
    string,
    { readonly connectionKey: string; readonly client: HermesCronGatewayClient }
  >();
  const sharedClient = (config: HermesCronProviderConfig): HermesCronGatewayClient => {
    const connectionKey = `${config.endpoint}\u0000${config.token}`;
    const existing = clients.get(config.providerInstanceId);
    if (existing !== undefined && existing.connectionKey === connectionKey) {
      return existing.client;
    }
    existing?.client.close();
    const client = clientFactory({ endpoint: config.endpoint, authToken: config.token });
    clients.set(config.providerInstanceId, { connectionKey, client });
    return client;
  };

  const configuredProviders = Effect.fn("HermesCron.configuredProviders")(function* () {
    const settings = yield* settingsService.getSettings.pipe(
      Effect.mapError(
        () =>
          new HermesCronError({
            code: "gateway_error",
            message: "Could not read Hermes provider settings.",
          }),
      ),
    );
    const directory = resolveHermesProviderConnections(settings);
    return {
      ready: directory.ready,
      unavailable: directory.unavailable.map((provider) =>
        unavailableProjection(
          provider.providerInstanceId,
          provider.displayName,
          provider.profileKey,
          provider.diagnostic,
        ),
      ),
    };
  });

  const loadProvider = Effect.fn("HermesCron.loadProvider")(function* (
    config: HermesCronProviderConfig,
  ) {
    return yield* Effect.tryPromise({
      try: async () => {
        const client = sharedClient(config);
        const compatibility = await client.connect();
        const capabilities = projectHermesCronCapabilities(compatibility);
        if (!capabilities.inventory) {
          return unavailableProjection(
            config.providerInstanceId,
            config.displayName,
            config.profileKey,
            "Gateway does not advertise cron.read.",
          );
        }
        const result = await client.listCronJobs();
        return projectProvider({ config, compatibility, result });
      },
      catch: () =>
        new HermesCronError({
          code: "gateway_error",
          providerInstanceId: config.providerInstanceId,
          message: "Could not read native Hermes cron inventory.",
        }),
    }).pipe(
      Effect.catch((error) =>
        Effect.succeed(
          unavailableProjection(
            config.providerInstanceId,
            config.displayName,
            config.profileKey,
            error.message,
            "error",
          ),
        ),
      ),
    );
  });

  const list: HermesCronShape["list"] = Effect.fn("HermesCron.list")(function* () {
    const configured = yield* configuredProviders();
    const available = yield* Effect.forEach(configured.ready, loadProvider, { concurrency: 4 });
    return { providers: [...available, ...configured.unavailable] };
  });

  const mutate: HermesCronShape["mutate"] = Effect.fn("HermesCron.mutate")(function* (input) {
    if (
      !input.operationId.trim() ||
      (input.operation === "create" &&
        (!input.name?.trim() || !input.schedule?.trim() || !input.prompt?.trim())) ||
      (input.operation !== "create" && !input.jobIdentity?.trim())
    ) {
      return yield* new HermesCronError({
        code: "invalid_input",
        providerInstanceId: input.providerInstanceId,
        operation: input.operation,
        message: "Cron mutation is missing required identity or job fields.",
      });
    }
    const configured = yield* configuredProviders();
    const config = configured.ready.find(
      (candidate) => candidate.providerInstanceId === input.providerInstanceId,
    );
    if (!config) {
      const known = configured.unavailable.some(
        (candidate) => candidate.providerInstanceId === input.providerInstanceId,
      );
      return yield* new HermesCronError({
        code: known ? "provider_unavailable" : "provider_not_found",
        providerInstanceId: input.providerInstanceId,
        operation: input.operation,
        message: known ? "Hermes provider is unavailable." : "Hermes provider was not found.",
      });
    }

    return yield* Effect.tryPromise({
      try: async () => {
        const client = sharedClient(config);
        const compatibility = await client.connect();
        const capabilities = projectHermesCronCapabilities(compatibility);
        if (!mutationCapability(capabilities, input.operation)) {
          throw new HermesCronError({
            code: "unsupported_operation",
            providerInstanceId: input.providerInstanceId,
            operation: input.operation,
            message: `Hermes gateway does not support cron ${input.operation}.`,
          });
        }
        const result = await client.manageCron(mutationParams(input), {
          operationId: input.operationId,
        });
        const inventory = await client.listCronJobs().catch(() => null);
        return {
          provider: inventory
            ? projectProvider({ config, compatibility, result: inventory })
            : unavailableProjection(
                config.providerInstanceId,
                config.displayName,
                config.profileKey,
                "Cron mutation succeeded, but the follow-up cron inventory refresh failed.",
                "error",
              ),
          upstreamJobId: result.job_id ?? result.job?.id ?? null,
          upstreamRunId: result.run_id ?? null,
        };
      },
      catch: (cause) => {
        if (isHermesCronError(cause)) return cause;
        if (cause instanceof HermesGatewayMutationIndeterminateError) {
          return new HermesCronError({
            code: "indeterminate",
            providerInstanceId: input.providerInstanceId,
            operation: input.operation,
            message: "Hermes cron mutation outcome is indeterminate; automatic replay is disabled.",
          });
        }
        if (cause instanceof HermesGatewayMutationsBlockedError) {
          return new HermesCronError({
            code: "indeterminate",
            providerInstanceId: input.providerInstanceId,
            operation: input.operation,
            message:
              "Hermes cron mutations are blocked until indeterminate operations are reconciled.",
          });
        }
        if (cause instanceof HermesGatewayDuplicateOperationIdError) {
          return new HermesCronError({
            code: "invalid_input",
            providerInstanceId: input.providerInstanceId,
            operation: input.operation,
            message:
              "Hermes cron mutation operation id was already used; duplicate submissions are not replayed.",
          });
        }
        if (cause instanceof HermesGatewayConfigurationError) {
          return new HermesCronError({
            code: "gateway_error",
            providerInstanceId: input.providerInstanceId,
            operation: input.operation,
            message: `Hermes cron gateway is not configured correctly: ${cause.message}`,
          });
        }
        return new HermesCronError({
          code: "gateway_error",
          providerInstanceId: input.providerInstanceId,
          operation: input.operation,
          message: "Hermes cron gateway operation failed.",
        });
      },
    });
  });

  return HermesCron.of({ list, mutate });
});

export const layer = Layer.effect(HermesCron, makeHermesCron());
