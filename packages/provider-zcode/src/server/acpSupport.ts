import type * as EffectAcpSchema from "effect-acp/compat";
import {
  type OrchestrationV2ProviderFailure,
  type ProviderApprovalOption,
  type RuntimeMode,
  ZCODE_DEFAULT_MODEL,
} from "@t3tools/contracts";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";

import * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import type { ZCodeSettings } from "../settings.ts";

type ZCodeAcpRuntimeSettings = Pick<ZCodeSettings, "binaryPath" | "zcodeBinaryPath">;

export interface ZCodeAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly zcodeSettings: ZCodeAcpRuntimeSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
  readonly runtimeMode?: RuntimeMode;
}

/**
 * The bridge's only auth method. It reads the plan credentials the ZCode
 * desktop app manages, so T3 never holds a ZCode key.
 */
export const ZCODE_ACP_AUTH_METHOD_ID = "zcode-credentials";

/**
 * The runtime modes ZCode's permission service enforces itself: `build` asks
 * for anything beyond read-only tools, `edit` also allows workspace edits, and
 * `yolo` allows everything. ZCode's `auto` mode is reserved upstream and
 * denies every tool, so T3's Auto is not offered.
 */
export const ZCODE_SUPPORTED_RUNTIME_MODES = [
  "approval-required",
  "auto-accept-edits",
  "full-access",
] as const satisfies ReadonlyArray<RuntimeMode>;

/** ZCode's native mode for a runtime mode. An unoffered mode runs asking. */
export function zcodePermissionMode(runtimeMode: RuntimeMode | undefined): string {
  switch (runtimeMode) {
    case "full-access":
      return "yolo";
    case "auto-accept-edits":
      return "edit";
    default:
      return "build";
  }
}

/**
 * The approval choices a ZCode permission prompt can honor. ZCode's
 * `allow_always` answer is "Always allow in this project", a grant ZCode keeps
 * beyond the session, so it is not offered as a session choice.
 */
export function zcodeApprovalOptions(
  request: EffectAcpSchema.RequestPermissionRequest,
): ReadonlyArray<ProviderApprovalOption> {
  const has = (kind: EffectAcpSchema.PermissionOption["kind"]) =>
    request.options.some((option) => option.kind === kind);
  return [
    { decision: "cancel", label: "Cancel" },
    ...(has("reject_once") ? [{ decision: "decline", label: "Decline" } as const] : []),
    ...(has("allow_once") ? [{ decision: "accept", label: "Approve" } as const] : []),
  ];
}

/**
 * Bridge features T3 owns or must not inherit: the remote-access hub would
 * expose the session over WebSocket, and quota auto-resume would restart work
 * after T3 already settled the turn as Limited.
 */
const ZCODE_BRIDGE_ENV_REMOVED = [
  "ZCODE_ACP_REMOTE",
  "ZCODE_ACP_REMOTE_TOKEN",
  "ZCODE_ACP_REMOTE_ORIGIN",
  "ZCODE_ACP_REMOTE_PIN_CWD",
  "ZCODE_ACP_RESUME_SESSION",
  "ZCODE_ACP_TUI_CLI_PID",
] as const;

export function buildZCodeAcpSpawnInput(
  zcodeSettings: ZCodeAcpRuntimeSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
  runtimeMode?: RuntimeMode,
): AcpSessionRuntime.AcpSpawnInput {
  const env: NodeJS.ProcessEnv = { ...environment };
  for (const key of ZCODE_BRIDGE_ENV_REMOVED) delete env[key];
  const zcodeBinaryPath = zcodeSettings?.zcodeBinaryPath?.trim();
  return {
    command: zcodeSettings?.binaryPath || "zcode-acp-server",
    args: [],
    cwd,
    env: {
      ...env,
      ...(zcodeBinaryPath ? { ZCODE_BIN: zcodeBinaryPath } : {}),
      // The bridge creates sessions in `yolo` unless told otherwise. T3 also
      // selects the mode after session/new; this covers the window before.
      ZCODE_ACP_MODE: zcodePermissionMode(runtimeMode),
      ZCODE_ACP_QUOTA_AUTO_RESUME: "0",
    },
  };
}

/**
 * The bridge appends a status line ("✓ completed · cache …", "⚠ stopped early")
 * to every turn as an agent message. T3 shows turn state itself, so the line is
 * dropped. The bridge marks it with a `turninfo_` message id.
 */
export function normalizeZCodeSessionUpdate(
  notification: EffectAcpSchema.SessionNotification,
): EffectAcpSchema.SessionNotification {
  const update = notification.update;
  if (
    update.sessionUpdate === "agent_message_chunk" &&
    typeof update.messageId === "string" &&
    update.messageId.startsWith("turninfo_") &&
    update.content.type === "text"
  ) {
    return {
      ...notification,
      update: { ...update, content: { ...update.content, text: "" } },
    };
  }
  return notification;
}

export const makeZCodeAcpRuntime = (
  input: ZCodeAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const { zcodeSettings, environment, runtimeMode, childProcessSpawner, ...options } = input;
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...options,
        spawn: buildZCodeAcpSpawnInput(zcodeSettings, input.cwd, environment, runtimeMode),
        authMethodId: ZCODE_ACP_AUTH_METHOD_ID,
      }).pipe(
        Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner)),
      ),
    );
    return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
      Effect.provide(acpContext),
    );
  });

function zcodeModelOptions(configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>) {
  const model = configOptions.find((option) => option.category === "model");
  if (model?.type !== "select") return { configId: undefined, current: undefined, values: [] };
  return {
    configId: model.id,
    current: model.currentValue,
    values: model.options.flatMap((entry) => ("value" in entry ? [entry] : entry.options)),
  };
}

/**
 * Applies a thread's model. The default alias keeps the session's current
 * model and is never sent. A saved model the account no longer offers fails
 * with a message rather than silently running on another model.
 */
export const applyZCodeAcpModelSelection = Effect.fn("applyZCodeAcpModelSelection")(function* <
  E,
>(input: {
  readonly runtime: Pick<
    AcpSessionRuntime.AcpSessionRuntime["Service"],
    "getConfigOptions" | "setConfigOption"
  >;
  readonly model: string | null | undefined;
  readonly mapError: (cause: EffectAcpErrors.AcpError) => E;
}): Effect.fn.Return<string | undefined, E> {
  const configOptions = yield* input.runtime.getConfigOptions;
  const { configId, current, values } = zcodeModelOptions(configOptions);
  const requested = input.model?.trim();
  if (!requested || requested === ZCODE_DEFAULT_MODEL || requested === current) return current;
  if (configId === undefined || !values.some((option) => option.value === requested)) {
    return yield* Effect.fail(
      input.mapError(
        EffectAcpErrors.AcpRequestError.invalidParams(
          `ZCode model '${requested}' is not available. Select a model your ZCode account offers.`,
        ),
      ),
    );
  }
  yield* input.runtime.setConfigOption(configId, requested).pipe(Effect.mapError(input.mapError));
  return requested;
});

/**
 * Provider business codes ZCode treats as a quota stop (GLM coding-plan usage
 * caps and the OpenAI-compatible spend limits).
 */
const ZCODE_QUOTA_PROVIDER_CODES: ReadonlySet<string> = new Set([
  "1005",
  "1308",
  "1310",
  "1313",
  "1316",
  "1317",
  "1318",
  "1319",
  "1320",
  "1321",
  "2056",
  "20097",
  "insufficient_quota",
  "credit_balance_exhausted",
  "organization_spend_limit_exceeded",
  "project_spend_limit_exceeded",
  "organization_usage_limit_exceeded",
  "exceeded_current_quota_error",
]);

const ZCodeTurnFailureData = Schema.Struct({
  type: Schema.Literal("zcode_turn_failed"),
  code: Schema.optional(Schema.String),
  providerCode: Schema.optional(Schema.String),
  statusCode: Schema.optional(Schema.Number),
  retryable: Schema.optional(Schema.Boolean),
  retryAfterMs: Schema.optional(Schema.Number),
});
const decodeZCodeTurnFailureData = Schema.decodeUnknownOption(ZCodeTurnFailureData);
const isAcpRequestError = Schema.is(EffectAcpErrors.AcpRequestError);

export function zcodePromptFailure(
  cause: unknown,
  now: () => number = Date.now,
): OrchestrationV2ProviderFailure {
  if (!isAcpRequestError(cause)) {
    return makeProviderFailure({ cause, class: "provider_error" });
  }
  const data = decodeZCodeTurnFailureData(cause.data);
  const failure = data._tag === "Some" ? data.value : undefined;
  const usageLimit =
    failure?.providerCode !== undefined && ZCODE_QUOTA_PROVIDER_CODES.has(failure.providerCode);
  return makeProviderFailure({
    cause,
    message: cause.errorMessage,
    code: failure?.providerCode ?? String(cause.code),
    class: usageLimit ? "usage_limit" : "provider_error",
    ...(failure?.retryable === undefined ? {} : { retryable: failure.retryable }),
    ...(usageLimit && failure?.retryAfterMs !== undefined
      ? { resetAt: DateTime.formatIso(DateTime.makeUnsafe(now() + failure.retryAfterMs)) }
      : {}),
  });
}
