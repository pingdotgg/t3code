import type * as EffectAcpSchema from "effect-acp/compat";
import {
  ProviderDriverKind,
  type ModelSelection,
  type ProviderApprovalOption,
  type RuntimeMode,
  type SelectProviderOptionDescriptor,
  type ServerProviderRuntimeMode,
} from "@t3tools/contracts";
import type { SparrowSettings } from "../settings.ts";
import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import type * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type * as EffectAcpErrors from "effect-acp/errors";

import * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import {
  acpLocationsWithinRoots,
  acpPermissionDisposition,
  acpPolicyRequiresApproval,
  unknownRecord,
  type AcpPermissionDisposition,
  type AcpRuntimePolicy,
} from "@t3tools/provider-acp/server/clientPolicy";
import { flattenSelectChoices } from "@t3tools/provider-acp/server/sessionConfig";
import * as HostProcess from "@t3tools/shared/HostProcess";

export const SPARROW_DRIVER_KIND = ProviderDriverKind.make("sparrow");
export const SPARROW_DEFAULT_MODEL_SLUG = "default";
const SPARROW_MODEL_CONFIG_ID = "model";
export const SPARROW_THOUGHT_LEVEL_CONFIG_ID = "thought_level";
export const SPARROW_PERMISSION_MODE_CONFIG_ID = "permission_mode";
export const SPARROW_EXTENSION_METHOD = "_sparrow/session";
export const SPARROW_ACP_CANCEL_BEHAVIOR = "wait-for-prompt" as const;

export type SparrowPermissionMode = "read_only" | "workspace_write" | "full_access";

export const SPARROW_CLIENT_CAPABILITIES_META = {
  sparrow: {
    permissions: {
      gateReads: true,
    },
  },
} as const;

const SPARROW_THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type SparrowThinkingLevel = (typeof SPARROW_THINKING_LEVELS)[number];

const SPARROW_THINKING_LEVEL_SET: ReadonlySet<string> = new Set(SPARROW_THINKING_LEVELS);

const SPARROW_THINKING_LABELS: Record<SparrowThinkingLevel, string> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
};

export const SPARROW_SUPPORTED_RUNTIME_MODES = [
  "read-only",
  "workspace-write",
  "full-access",
] as const satisfies ReadonlyArray<RuntimeMode>;

export const SPARROW_RUNTIME_MODES: ReadonlyArray<ServerProviderRuntimeMode> = [
  {
    mode: "read-only",
    label: "Read only",
    description: "Allow read and search tools only; block edits, shell commands, and MCP calls.",
    icon: "eye",
  },
  {
    mode: "workspace-write",
    label: "Workspace write",
    description: "Auto-approve workspace edits and shell; ask otherwise.",
    icon: "shield-check",
  },
  {
    mode: "full-access",
    label: "Full access",
    description: "Disable the write sandbox and execute tools without prompts.",
    icon: "shield-off",
  },
];

export function encodeSparrowAcpModelId(provider: string, modelId: string): string {
  const escapedProvider = provider.replaceAll("%", "%25").replaceAll("/", "%2F");
  return `${escapedProvider}/${modelId}`;
}

export interface ParsedSparrowModelRef {
  readonly provider?: string;
  readonly modelId: string;
  readonly acpModelId?: string;
  readonly thinkingLevel?: SparrowThinkingLevel;
}

function readBracketedSegment(
  raw: string,
): { readonly value: string; readonly rest: string } | undefined {
  if (raw.startsWith("<")) {
    const closeIndex = raw.indexOf(">");
    if (closeIndex <= 1) return undefined;
    return { value: raw.slice(1, closeIndex), rest: raw.slice(closeIndex + 1) };
  }
  const slashIndex = raw.indexOf("/");
  if (slashIndex === -1) {
    return raw.length > 0 ? { value: raw, rest: "" } : undefined;
  }
  return slashIndex > 0
    ? { value: raw.slice(0, slashIndex), rest: raw.slice(slashIndex) }
    : undefined;
}

/**
 * Parses Sparrow `config.json` model references (`provider/model`, `provider/<model>`,
 * `provider/<model>/level`, or `<provider>/<org/model>/level`) into provider, raw model ID,
 * percent-encoded ACP ID, and optional trailing thinking level.
 */
export function parseSparrowModelRef(raw: string): ParsedSparrowModelRef | undefined {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;

  const first = readBracketedSegment(trimmed);
  if (!first) return undefined;
  if (first.rest.length === 0) {
    return { modelId: first.value };
  }
  if (!first.rest.startsWith("/")) return undefined;

  const afterProvider = first.rest.slice(1);
  if (afterProvider.length === 0) return undefined;

  if (afterProvider.startsWith("<")) {
    const modelSeg = readBracketedSegment(afterProvider);
    if (!modelSeg) return undefined;
    let thinkingLevel: SparrowThinkingLevel | undefined;
    if (modelSeg.rest.length > 0) {
      if (!modelSeg.rest.startsWith("/")) return undefined;
      const level = modelSeg.rest.slice(1);
      if (!SPARROW_THINKING_LEVEL_SET.has(level)) return undefined;
      thinkingLevel = level as SparrowThinkingLevel;
    }
    return {
      provider: first.value,
      modelId: modelSeg.value,
      acpModelId: encodeSparrowAcpModelId(first.value, modelSeg.value),
      ...(thinkingLevel ? { thinkingLevel } : {}),
    };
  }

  const parts = afterProvider.split("/");
  if (parts.length >= 2) {
    const candidateLevel = parts[parts.length - 1];
    if (candidateLevel !== undefined && SPARROW_THINKING_LEVEL_SET.has(candidateLevel)) {
      const modelId = parts.slice(0, -1).join("/");
      if (modelId.length > 0) {
        return {
          provider: first.value,
          modelId,
          acpModelId: encodeSparrowAcpModelId(first.value, modelId),
          thinkingLevel: candidateLevel as SparrowThinkingLevel,
        };
      }
    }
  }

  return {
    provider: first.value,
    modelId: afterProvider,
    acpModelId: encodeSparrowAcpModelId(first.value, afterProvider),
  };
}

export function buildSparrowThoughtLevelDescriptor(input: {
  readonly reasoning?: boolean;
  readonly thinkingLevelMap?: Readonly<Record<string, string | null>> | undefined;
  readonly defaultLevel?: string | undefined;
}): SelectProviderOptionDescriptor | undefined {
  const reasoning = input.reasoning === true;
  const levelMap = input.thinkingLevelMap;
  const hasExplicitMap = levelMap !== undefined && Object.keys(levelMap).length > 0;

  const levels = SPARROW_THINKING_LEVELS.filter((level) => reasoning || level === "off").filter(
    (level) =>
      !hasExplicitMap ||
      (levelMap !== undefined &&
        Object.hasOwn(levelMap, level) &&
        levelMap[level] !== null &&
        levelMap[level] !== undefined),
  );

  if (levels.length <= 1) {
    return undefined;
  }

  const defaultLevel =
    input.defaultLevel && levels.includes(input.defaultLevel as SparrowThinkingLevel)
      ? input.defaultLevel
      : levels.includes("medium")
        ? "medium"
        : levels.includes("high")
          ? "high"
          : levels[0];

  return {
    id: SPARROW_THOUGHT_LEVEL_CONFIG_ID,
    label: "Thinking",
    type: "select",
    role: "reasoning",
    options: levels.map((level) => ({
      id: level,
      label: input.thinkingLevelMap?.[level]?.trim() || SPARROW_THINKING_LABELS[level],
      ...(level === defaultLevel ? { isDefault: true } : {}),
    })),
    ...(defaultLevel ? { currentValue: defaultLevel } : {}),
  };
}

export type SparrowAcpRuntimeSettings = Pick<
  SparrowSettings,
  "binaryPath" | "homePath" | "launchArgs"
>;

export function resolveSparrowProcessEnvironment(
  settings: Pick<SparrowSettings, "homePath"> | null | undefined,
  environment: NodeJS.ProcessEnv | undefined,
  platform?: NodeJS.Platform,
): NodeJS.ProcessEnv | undefined {
  const homePath = settings?.homePath?.trim();
  if (!homePath) {
    return environment;
  }
  return {
    ...environment,
    HOME: homePath,
    ...(platform === "win32" ? { USERPROFILE: homePath } : {}),
  };
}

export function buildSparrowAcpSpawnInput(
  settings: SparrowAcpRuntimeSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
  platform?: NodeJS.Platform,
): AcpSessionRuntime.AcpSpawnInput {
  const env = resolveSparrowProcessEnvironment(settings, environment, platform);
  const extraArgs = tokenizeCliArgs(settings?.launchArgs);
  return {
    command: settings?.binaryPath || "sparrow",
    args: [...extraArgs, "--acp"],
    cwd,
    ...(env === undefined ? {} : { env }),
  };
}

/**
 * Approving `"allow_session"` in Sparrow enables `full_access = true` for the remainder
 * of that ACP session. Auto-approved policy calls use `"allow_once"` so switching runtime
 * modes mid-session stays reversible.
 */
export function sparrowApprovalOptions(
  request: EffectAcpSchema.RequestPermissionRequest,
): ReadonlyArray<ProviderApprovalOption> {
  const has = (kind: EffectAcpSchema.PermissionOption["kind"]) =>
    request.options.some((option) => option.kind === kind && option.optionId.trim().length > 0);
  return [
    ...(has("allow_once") ? [{ decision: "accept", label: "Allow once" } as const] : []),
    ...(has("allow_always")
      ? [{ decision: "acceptForSession", label: "Always allow" } as const]
      : []),
    ...(has("reject_once") ? [{ decision: "decline", label: "Deny" } as const] : []),
    { decision: "cancel", label: "Cancel" },
  ];
}

export function sparrowPermissionModeForPolicy(policy: {
  readonly runtimeMode: RuntimeMode;
  readonly approvalPolicy?: unknown;
  readonly sandboxPolicy?: unknown;
}): SparrowPermissionMode {
  const sandboxType = unknownRecord(policy.sandboxPolicy)?.type;
  if (sandboxType === "readOnly") return "read_only";
  if (sandboxType === "workspaceWrite") return "workspace_write";
  if (sandboxType === "dangerFullAccess") {
    if (policy.approvalPolicy === "never") return "full_access";
    if (
      policy.approvalPolicy === undefined &&
      policy.runtimeMode !== "approval-required" &&
      policy.runtimeMode !== "read-only"
    ) {
      return "full_access";
    }
    return "workspace_write";
  }
  if (sandboxType === "externalSandbox") {
    if (policy.approvalPolicy === "never") return "full_access";
    if (policy.approvalPolicy === undefined && policy.runtimeMode === "full-access") {
      return "full_access";
    }
    return "workspace_write";
  }
  if (policy.runtimeMode === "read-only") return "read_only";
  if (
    policy.runtimeMode === "full-access" &&
    (policy.approvalPolicy === undefined || policy.approvalPolicy === "never")
  ) {
    return "full_access";
  }
  return "workspace_write";
}

function isSparrowEscalatedPermissionRequest(
  request: EffectAcpSchema.RequestPermissionRequest,
): boolean {
  if (unknownRecord(request._meta)?.["sparrow/escalated"] === true) {
    return true;
  }
  // Back-compat fallback for older Sparrow binaries before `_meta["sparrow/escalated"]`.
  return (
    typeof request.toolCall.title === "string" &&
    request.toolCall.title.includes(` ${String.fromCharCode(0x2014)} `)
  );
}

export function sparrowPermissionDisposition(
  policy: AcpRuntimePolicy,
  request: EffectAcpSchema.RequestPermissionRequest,
): AcpPermissionDisposition {
  const toolKind = request.toolCall.kind ?? "other";
  const sandboxPolicy = unknownRecord(policy.sandboxPolicy);
  const offersOnce = request.options.some(
    (option) => option.kind === "allow_once" && option.optionId.trim().length > 0,
  );
  const allowOrAsk = (): AcpPermissionDisposition => (offersOnce ? "allow" : "ask");

  if (toolKind === "search" && sandboxPolicy?.networkAccess === false) {
    return acpPolicyRequiresApproval(policy) ? "ask" : "deny";
  }

  if (toolKind === "read") {
    const sandboxAccess = unknownRecord(sandboxPolicy?.access);
    if (sandboxPolicy?.type === "readOnly" && sandboxAccess?.type === "restricted") {
      const readableRoots = Array.isArray(sandboxAccess.readableRoots)
        ? sandboxAccess.readableRoots
        : [];
      const hasLocations = (request.toolCall.locations?.length ?? 0) > 0;
      const allowed =
        hasLocations &&
        acpLocationsWithinRoots({
          cwd: policy.cwd,
          roots: readableRoots,
          locations: request.toolCall.locations,
        });
      if (!allowed && (hasLocations || request.toolCall.title === "read: read")) {
        return acpPolicyRequiresApproval(policy) ? "ask" : "deny";
      }
    }
    if (sandboxPolicy === undefined) {
      return allowOrAsk();
    }
  }

  if (sandboxPolicy === undefined && policy.approvalPolicy === undefined) {
    if (policy.runtimeMode === "read-only") {
      return toolKind === "search" ? allowOrAsk() : "deny";
    }
    if (policy.runtimeMode === "workspace-write") {
      if (toolKind === "search") {
        return allowOrAsk();
      }
      if (toolKind === "edit" || toolKind === "delete" || toolKind === "move") {
        return acpLocationsWithinRoots({
          cwd: policy.cwd,
          roots: policy.cwd === null ? [] : [policy.cwd],
          locations: request.toolCall.locations,
        })
          ? allowOrAsk()
          : "ask";
      }
      if (toolKind === "execute") {
        return isSparrowEscalatedPermissionRequest(request) ? "ask" : allowOrAsk();
      }
      return "ask";
    }
  }

  if (
    sandboxPolicy === undefined &&
    policy.approvalPolicy === undefined &&
    policy.runtimeMode === "auto-accept-edits" &&
    (toolKind === "edit" || toolKind === "delete" || toolKind === "move") &&
    !acpLocationsWithinRoots({
      cwd: policy.cwd,
      roots: policy.cwd === null ? [] : [policy.cwd],
      locations: request.toolCall.locations,
    })
  ) {
    return "ask";
  }

  const disposition = acpPermissionDisposition(policy, request);
  return disposition === "allow" && !offersOnce ? "ask" : disposition;
}

const findConfigOption = (
  options: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
  configId: string,
  category?: string,
) =>
  options.find(
    (option) => option.id === configId || (category !== undefined && option.category === category),
  );

export const applySparrowModelSelection: NonNullable<
  AcpAdapterV2FlavorOption["applyModelSelection"]
> = Effect.fn("SparrowAdapter.applyModelSelection")(function* ({ runtime, modelSelection }) {
  const requestedModel = modelSelection.model.trim();
  const initialOptions = yield* runtime.getConfigOptions;
  const modelOption = findConfigOption(initialOptions, SPARROW_MODEL_CONFIG_ID, "model");
  let appliedModel = modelOption?.type === "select" ? modelOption.currentValue : undefined;

  if (requestedModel.length > 0 && requestedModel !== SPARROW_DEFAULT_MODEL_SLUG) {
    if (modelOption?.type === "select") {
      const listed = flattenSelectChoices(modelOption.options).some(
        (choice) => choice.value === requestedModel,
      );
      yield* runtime.setConfigOption(modelOption.id, requestedModel, {
        allowUnlistedValue: !listed,
      });
    } else {
      yield* runtime.setSessionModel(requestedModel);
    }
    appliedModel = requestedModel;
  }

  const requestedThoughtLevel = getModelSelectionStringOptionValue(
    modelSelection,
    SPARROW_THOUGHT_LEVEL_CONFIG_ID,
  );
  if (requestedThoughtLevel !== undefined && requestedThoughtLevel.length > 0) {
    const updatedOptions = yield* runtime.getConfigOptions;
    const thoughtOption = findConfigOption(
      updatedOptions,
      SPARROW_THOUGHT_LEVEL_CONFIG_ID,
      SPARROW_THOUGHT_LEVEL_CONFIG_ID,
    );
    if (thoughtOption?.type === "select") {
      const supportsChoice = flattenSelectChoices(thoughtOption.options).some(
        (choice) => choice.value === requestedThoughtLevel,
      );
      if (supportsChoice) {
        yield* runtime.setConfigOption(thoughtOption.id, requestedThoughtLevel);
      }
    }
  }

  return appliedModel;
});

type AcpAdapterV2FlavorOption = {
  readonly applyModelSelection?: (input: {
    readonly runtime: AcpSessionRuntime.AcpSessionRuntime["Service"];
    readonly startResult: AcpSessionRuntime.AcpSessionRuntimeStartResult;
    readonly modelSelection: ModelSelection;
  }) => Effect.Effect<string | undefined, EffectAcpErrors.AcpError>;
};

export interface SparrowAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "spawn"
> {
  readonly settings: SparrowAcpRuntimeSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
}

export const makeSparrowAcpRuntime = Effect.fn("SparrowAcpSupport.makeSparrowAcpRuntime")(
  function* (
    input: SparrowAcpRuntimeInput,
  ): Effect.fn.Return<
    AcpSessionRuntime.AcpSessionRuntime["Service"],
    EffectAcpErrors.AcpError,
    ChildProcessSpawner.ChildProcessSpawner | SecureRandom.SecureRandom | Scope.Scope
  > {
    const { settings, environment, ...runtimeOptions } = input;
    const platform = yield* HostProcess.Platform;
    const context = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...runtimeOptions,
        cancelBehavior: SPARROW_ACP_CANCEL_BEHAVIOR,
        spawn: buildSparrowAcpSpawnInput(settings, input.cwd, environment, platform),
      }),
    );
    return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(Effect.provide(context));
  },
);
