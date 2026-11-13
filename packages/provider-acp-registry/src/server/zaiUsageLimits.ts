import {
  type ServerProviderUsageLimits,
  type ServerProviderUsageWindow,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import type { AcpRegistrySettings } from "../settings.ts";
import {
  clampPercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "@t3tools/provider-core/server/usageLimits";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export const ZAI_GLM_AGENT_ID = "glm-acp-agent";
const GLM_USAGE_CAPABILITY_KEY = `${ZAI_GLM_AGENT_ID}/usage`;
export const GLM_USAGE_METHOD = "_glm/usage";

const GLM_UPDATE_MESSAGE = "Update GLM Agent to 1.16 or newer to see Coding Plan limits.";
export const GLM_READ_FAILED_MESSAGE = "GLM Agent could not read Coding Plan limits.";
const GLM_NO_WINDOWS_MESSAGE = "GLM Agent reported no Coding Plan limits.";

const ZAI_MANAGE_URL = "https://z.ai/manage-apikey/coding-plan/personal/my-plan";
const BIGMODEL_USAGE_URL = "https://bigmodel.cn/coding-plan/personal/usage";
const BIGMODEL_USAGE_HOSTS = new Set(["open.bigmodel.cn", "dev.bigmodel.cn"]);

const MAX_WINDOWS = 64;
const MAX_MESSAGE_LENGTH = 300;

export function isZaiUsageLimitsInstance(settings: AcpRegistrySettings): boolean {
  return (
    settings.enabled &&
    settings.source === "registry" &&
    settings.agentId.trim() === ZAI_GLM_AGENT_ID
  );
}

const GlmUsageCapability = Schema.Struct({
  version: Schema.Literal(1),
  method: Schema.Literal(GLM_USAGE_METHOD),
});
const decodeGlmUsageCapability = Schema.decodeUnknownOption(GlmUsageCapability);

export function readGlmUsageCapability(initialize: {
  readonly agentCapabilities?:
    | { readonly _meta?: { readonly [key: string]: unknown } | null }
    | undefined;
}): boolean {
  const capability = initialize.agentCapabilities?._meta?.[GLM_USAGE_CAPABILITY_KEY];
  return Option.isSome(decodeGlmUsageCapability(capability));
}

const GlmUsageWindow = Schema.Struct({
  id: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  kind: Schema.optional(Schema.String),
  usedPercent: Schema.Number,
  resetsAt: Schema.optional(Schema.String),
  windowDurationMins: Schema.optional(Schema.Number),
});
const decodeGlmUsageWindow = Schema.decodeUnknownOption(GlmUsageWindow);

const GlmUsageUnavailable = Schema.Struct({
  reason: Schema.String,
  message: Schema.optional(Schema.String),
});

const GlmUsageResult = Schema.Struct({
  checkedAt: Schema.optional(Schema.String),
  windows: Schema.optional(Schema.Array(Schema.Unknown)),
  unavailable: Schema.optional(GlmUsageUnavailable),
});
const decodeGlmUsageResult = Schema.decodeUnknownOption(GlmUsageResult);

const windowKind = (kind: string | undefined): ServerProviderUsageWindow["kind"] =>
  kind === "session" || kind === "weekly" || kind === "monthly" ? kind : "other";

const isIsoDate = (value: string | undefined): value is string =>
  value !== undefined && Number.isFinite(Date.parse(value));

const agentMessage = (message: string | undefined): string | undefined => {
  const trimmed = message?.trim().slice(0, MAX_MESSAGE_LENGTH);
  return trimmed ? trimmed : undefined;
};

function zaiExternalUsageUrl(environment: NodeJS.ProcessEnv): string {
  const baseUrl = environment.ACP_GLM_BASE_URL?.trim();
  if (baseUrl) {
    try {
      if (BIGMODEL_USAGE_HOSTS.has(new URL(baseUrl).hostname)) return BIGMODEL_USAGE_URL;
    } catch {
      // A non-URL value is the agent's problem, not ours; the link stays on z.ai.
    }
  }
  return ZAI_MANAGE_URL;
}

const zaiExternalUsage = (environment: NodeJS.ProcessEnv) => ({
  label: "Z.ai usage",
  url: zaiExternalUsageUrl(environment),
});

// Limits shows an unsupported state's message only on its usage-link card.
export function glmUpdateRequiredLimits(input: {
  readonly environment: NodeJS.ProcessEnv;
  readonly checkedAt: string;
}): ServerProviderUsageLimits {
  return {
    ...makeUnavailableUsageLimits({
      checkedAt: input.checkedAt,
      reason: "unsupported",
      message: GLM_UPDATE_MESSAGE,
    }),
    externalUsage: zaiExternalUsage(input.environment),
  };
}

function mapGlmWindow(raw: unknown): readonly ServerProviderUsageWindow[] {
  const decoded = decodeGlmUsageWindow(raw);
  if (Option.isNone(decoded)) return [];
  const { id, label, kind, usedPercent, resetsAt, windowDurationMins } = decoded.value;
  return [
    {
      id,
      label,
      kind: windowKind(kind),
      usedPercent: clampPercent(usedPercent),
      ...(isIsoDate(resetsAt) ? { resetsAt } : {}),
      ...(windowDurationMins !== undefined &&
      Number.isInteger(windowDurationMins) &&
      windowDurationMins >= 0
        ? { windowDurationMins }
        : {}),
      // time_limit-* windows are the agent's tool-call allowance; the model itself stays usable.
      ...(id.startsWith("time_limit-") ? { blocksModel: false } : {}),
    },
  ];
}

export interface GlmUsageRead {
  readonly limits: ServerProviderUsageLimits;
  /** Whether the agent's credentials worked; absent when the reply cannot tell. */
  readonly signedIn?: boolean;
}

export function glmSignIn(result: unknown): boolean | undefined {
  const decoded = decodeGlmUsageResult(result);
  if (Option.isNone(decoded)) return undefined;
  const reason = decoded.value.unavailable?.reason;
  if (reason === undefined) return true;
  return reason === "missingCredentials" || reason === "authenticationFailed" ? false : undefined;
}

export function mapGlmUsageLimits(input: {
  readonly result: unknown;
  readonly environment: NodeJS.ProcessEnv;
  readonly readAt: string;
}): ServerProviderUsageLimits {
  const externalUsage = zaiExternalUsage(input.environment);
  const decoded = decodeGlmUsageResult(input.result);
  if (Option.isNone(decoded)) {
    return makeUnavailableUsageLimits({
      checkedAt: input.readAt,
      reason: "probeFailed",
      message: GLM_READ_FAILED_MESSAGE,
    });
  }
  const { checkedAt, windows, unavailable } = decoded.value;
  const resolvedCheckedAt = isIsoDate(checkedAt) ? checkedAt : input.readAt;
  if (unavailable !== undefined) {
    const message = agentMessage(unavailable.message);
    if (
      unavailable.reason === "missingCredentials" ||
      unavailable.reason === "unsupportedEndpoint"
    ) {
      return {
        ...makeUnavailableUsageLimits({
          checkedAt: resolvedCheckedAt,
          reason: "unsupported",
          message: message ?? GLM_NO_WINDOWS_MESSAGE,
        }),
        externalUsage,
      };
    }
    return makeUnavailableUsageLimits({
      checkedAt: resolvedCheckedAt,
      reason: "probeFailed",
      message: message ?? GLM_READ_FAILED_MESSAGE,
    });
  }
  const mapped = (windows ?? []).flatMap(mapGlmWindow).slice(0, MAX_WINDOWS);
  if (mapped.length === 0) {
    return {
      ...makeUnavailableUsageLimits({
        checkedAt: resolvedCheckedAt,
        reason: "unsupported",
        message: GLM_NO_WINDOWS_MESSAGE,
      }),
      externalUsage,
    };
  }
  return { ...makeUsageLimits({ checkedAt: resolvedCheckedAt, windows: mapped }), externalUsage };
}
