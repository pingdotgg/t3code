import {
  describeSandboxRetry,
  type SandboxCredentialEnvironment,
  type SandboxProviderErrorCode,
  type SandboxProviderInfo,
  type SandboxProviderLimits,
  SandboxProviderError,
  type SandboxProviderKind,
  type SandboxStage,
  type SandboxTemplate,
  type SandboxTemplateAllowance,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import * as Schema from "effect/Schema";

export interface SandboxProviderConfig {
  readonly apiKey: string;
}

export interface CreatedSandbox {
  readonly id: string;
  readonly name: string;
  /** A public URL for `port`, when the provider can route it at creation time. */
  readonly publicUrl?: string;
}

export interface SandboxExecResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** The provider's view of one machine, normalized; `starting` is transitional and never recorded. */
export type SandboxProviderStatus =
  | "running"
  | "starting"
  | "stopped"
  | "error"
  | "expired"
  | "deleted";

export interface SandboxUsage {
  readonly dollars: number;
  readonly since: string;
}

export interface SandboxProviderDriver {
  readonly info: Omit<SandboxProviderInfo, "configured" | "capabilities">;
  readonly defaultSize: string;
  readonly serverPort: number;
  readonly create: (input: {
    readonly config: SandboxProviderConfig;
    readonly name: string;
    readonly size: string;
    readonly ttlMinutes?: number | undefined;
    readonly environment?: string | undefined;
    /** One per provisioning attempt; providers that support it must not bill a retried create twice. */
    readonly idempotencyKey: string;
    /** Start from this saved template instead of a fresh machine. */
    readonly template?: string | undefined;
  }) => Effect.Effect<CreatedSandbox, SandboxProviderError, HttpClient.HttpClient>;
  /** Null when the account's limits are unreadable (for example a key without that scope). */
  readonly limits?: (input: {
    readonly config: SandboxProviderConfig;
  }) => Effect.Effect<SandboxProviderLimits | null, SandboxProviderError, HttpClient.HttpClient>;
  readonly listEnvironments?: (input: {
    readonly config: SandboxProviderConfig;
  }) => Effect.Effect<
    ReadonlyArray<SandboxCredentialEnvironment>,
    SandboxProviderError,
    HttpClient.HttpClient
  >;
  readonly execute: (input: {
    readonly config: SandboxProviderConfig;
    readonly sandboxId: string;
    readonly command: string;
    readonly timeoutSeconds: number;
  }) => Effect.Effect<SandboxExecResult, SandboxProviderError, HttpClient.HttpClient>;
  readonly exposePort: (input: {
    readonly config: SandboxProviderConfig;
    readonly sandboxId: string;
    readonly port: number;
  }) => Effect.Effect<string, SandboxProviderError, HttpClient.HttpClient>;
  readonly destroy: (input: {
    readonly config: SandboxProviderConfig;
    readonly sandboxId: string;
  }) => Effect.Effect<void, SandboxProviderError, HttpClient.HttpClient>;
  readonly stop?: (input: {
    readonly config: SandboxProviderConfig;
    readonly sandboxId: string;
  }) => Effect.Effect<void, SandboxProviderError, HttpClient.HttpClient>;
  readonly resume?: (input: {
    readonly config: SandboxProviderConfig;
    readonly sandboxId: string;
    readonly ttlMinutes?: number | undefined;
  }) => Effect.Effect<{ readonly publicUrl?: string }, SandboxProviderError, HttpClient.HttpClient>;
  /**
   * A machine the provider no longer has is `deleted`, not an error. Null for a provider state
   * T3 does not track, so the record is left alone.
   */
  readonly status?: (input: {
    readonly config: SandboxProviderConfig;
    readonly sandboxId: string;
  }) => Effect.Effect<SandboxProviderStatus | null, SandboxProviderError, HttpClient.HttpClient>;
  /**
   * Moves the provider's own backstop to match an extended deadline. `ttlMinutes` is the time left
   * until the new deadline, counted from now.
   */
  readonly extend?: (input: {
    readonly config: SandboxProviderConfig;
    readonly sandboxId: string;
    readonly ttlMinutes: number;
    readonly running: boolean;
  }) => Effect.Effect<void, SandboxProviderError, HttpClient.HttpClient>;
  /**
   * Saves a stopped sandbox's disk under `name` and waits until it can start new sandboxes. The
   * provisioner scrubs T3's identity and stops the machine first; the driver waits for the
   * provider to finish stopping when its snapshot needs that.
   */
  readonly saveTemplate?: (input: {
    readonly config: SandboxProviderConfig;
    readonly sandboxId: string;
    readonly name: string;
  }) => Effect.Effect<SandboxTemplate, SandboxProviderError, HttpClient.HttpClient>;
  /** Only templates T3 saved, never the provider's own base images. */
  readonly listTemplates?: (input: { readonly config: SandboxProviderConfig }) => Effect.Effect<
    {
      readonly templates: ReadonlyArray<SandboxTemplate>;
      readonly templateAllowance?: SandboxTemplateAllowance;
    },
    SandboxProviderError,
    HttpClient.HttpClient
  >;
  readonly deleteTemplate?: (input: {
    readonly config: SandboxProviderConfig;
    readonly name: string;
  }) => Effect.Effect<void, SandboxProviderError, HttpClient.HttpClient>;
  /** This month's cost of every T3 sandbox on the account in one call, keyed by sandbox id. */
  readonly usage?: (input: {
    readonly config: SandboxProviderConfig;
  }) => Effect.Effect<
    ReadonlyMap<string, SandboxUsage>,
    SandboxProviderError,
    HttpClient.HttpClient
  >;
}

const PROVIDER_ERROR_CODES: Record<string, SandboxProviderErrorCode> = {
  rate_limited: "rate_limited",
  IP_RATE_LIMIT_EXCEEDED: "rate_limited",
  limit_reached: "concurrency_full",
  member_limit_reached: "concurrency_full",
  billing_required: "billing_required",
  credit_required: "billing_required",
  trial_compute_limit_reached: "billing_required",
  team_member_cap_reached: "billing_required",
  machine_class_plan_required: "size_unavailable",
  trial_machine_class_not_allowed: "size_unavailable",
  invalid_type: "size_unavailable",
  snapshot_data_expired: "snapshot_expired",
  no_ready_machine: "capacity_unavailable",
  out_of_capacity: "capacity_unavailable",
  trial_saved_snapshots_not_allowed: "templates_unavailable",
  save_in_progress: "template_saving",
  snapshot_not_found: "not_found",
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const positiveNumber = (value: unknown): number | undefined => {
  const parsed = typeof value === "string" ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
};

const parseErrorBody = (body: string) => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return {};
  }
  if (!isRecord(parsed)) return {};
  const nested = isRecord(parsed.error) ? parsed.error : {};
  const details = isRecord(nested.details) ? nested.details : {};
  const code = [parsed.code, nested.code].find((value) => typeof value === "string");
  const window = [parsed.window, details.window].find(
    (value): value is string => value === "minute" || value === "hour" || value === "day",
  );
  return {
    code: typeof code === "string" ? code : undefined,
    window,
    retryAfterSeconds: [
      parsed.retryAfterSeconds,
      details.retryAfterSeconds,
      parsed.retryAfter,
      details.retryAfter,
    ]
      .map(positiveNumber)
      .find((value) => value !== undefined),
  };
};

// Boat sends `Retry-After`; Daytona sends one `Retry-After-<window>` header per rate limit.
const retryAfterHeader = (headers: Readonly<Record<string, string>>): number | undefined => {
  const values = Object.entries(headers)
    .filter(([name]) => name.toLowerCase().startsWith("retry-after"))
    .map(([, value]) => positiveNumber(value))
    .filter((value) => value !== undefined);
  return values.length === 0 ? undefined : Math.max(...values);
};

const providerName = (provider: SandboxProviderKind) =>
  `${provider.charAt(0).toUpperCase()}${provider.slice(1)}`;

const describeProviderFailure = (input: {
  readonly provider: SandboxProviderKind;
  readonly code: SandboxProviderErrorCode;
  readonly status: number;
  readonly window: string | undefined;
  readonly retryAfterSeconds: number | undefined;
}): string => {
  const name = providerName(input.provider);
  const retry = describeSandboxRetry(input.retryAfterSeconds);
  switch (input.code) {
    case "api_key_rejected":
      return "The provider rejected the API key.";
    case "rate_limited":
      return input.window === undefined
        ? `${name} is limiting requests right now.${retry}`
        : `${name}'s start limit for this ${input.window} is used up.${retry}`;
    case "concurrency_full":
      return `${name}'s limit on running sandboxes is reached. Stop or delete one first.`;
    case "billing_required":
      return `${name} needs a payment or a plan change before it starts another sandbox.`;
    case "size_unavailable":
      return `This machine size is not available on your ${name} plan.`;
    case "snapshot_expired":
      return `${name} no longer keeps this stopped sandbox's disk. Delete it and create a new one.`;
    case "capacity_unavailable":
      return `${name} has no free machines right now.${retry || " Try again in a few minutes."}`;
    case "not_found":
      return "The provider could not find this resource.";
    case "templates_unavailable":
      return `Your ${name} plan cannot save templates.`;
    case "template_saving":
      return "A template with this name is still being saved. Wait for it to finish.";
    case "unknown":
      return `The provider responded with HTTP ${input.status}.`;
  }
};

export const requestJson = Effect.fn("SandboxProvider.requestJson")(function* <
  S extends Schema.Top,
>(input: {
  readonly provider: SandboxProviderKind;
  readonly stage: SandboxStage;
  readonly request: HttpClientRequest.HttpClientRequest;
  readonly schema: S;
}): Effect.fn.Return<
  S["Type"],
  SandboxProviderError,
  HttpClient.HttpClient | S["DecodingServices"]
> {
  const client = yield* HttpClient.HttpClient;
  const response = yield* client.execute(input.request).pipe(
    Effect.mapError(
      (cause) =>
        new SandboxProviderError({
          provider: input.provider,
          stage: input.stage,
          // The transport message is bounded and does not include the request headers or body.
          detail: "The sandbox provider could not be reached.",
          cause,
        }),
    ),
  );
  if (response.status < 200 || response.status >= 300) {
    // Provider bodies can echo request values, so the reason stays structured and the body only
    // ever travels as the cause, never as an attribute or in the message shown to the client.
    const body = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
    const parsed = parseErrorBody(body);
    const providerCode = parsed.code === undefined ? undefined : PROVIDER_ERROR_CODES[parsed.code];
    const code: SandboxProviderErrorCode =
      providerCode ??
      (response.status === 401 || response.status === 403
        ? "api_key_rejected"
        : response.status === 404
          ? "not_found"
          : response.status === 429
            ? "rate_limited"
            : "unknown");
    const retryAfterSeconds = parsed.retryAfterSeconds ?? retryAfterHeader(response.headers);
    return yield* new SandboxProviderError({
      provider: input.provider,
      stage: input.stage,
      status: response.status,
      code,
      ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
      detail: describeProviderFailure({
        provider: input.provider,
        code,
        status: response.status,
        window: parsed.window,
        retryAfterSeconds,
      }),
      cause: new Error(body.slice(0, 2000)),
    });
  }
  return yield* HttpClientResponse.schemaBodyJson(input.schema)(response).pipe(
    Effect.mapError(
      () =>
        new SandboxProviderError({
          provider: input.provider,
          stage: input.stage,
          detail: "Unexpected response from the sandbox provider.",
        }),
    ),
  );
});

export const authorize = (
  request: HttpClientRequest.HttpClientRequest,
  apiKey: string,
): HttpClientRequest.HttpClientRequest =>
  HttpClientRequest.setHeaders(request, { authorization: `Bearer ${apiKey}` });

export const jsonBody = (
  request: HttpClientRequest.HttpClientRequest,
  value: unknown,
): HttpClientRequest.HttpClientRequest => HttpClientRequest.bodyJsonUnsafe(request, value);

export const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
