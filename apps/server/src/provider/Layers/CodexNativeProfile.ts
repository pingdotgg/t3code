import * as NodePath from "node:path";

import {
  type ModelSelection,
  ProviderInstanceId,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { createModelCapabilities, getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { expandHomePath } from "../../pathExpansion.ts";

export interface CodexEffectiveProfile {
  readonly modelProvider: string;
  readonly model: string;
  readonly reasoningEffort: string;
}

export interface CodexAuthorizedChildProfile {
  readonly modelProvider: string;
  readonly model: string;
  readonly reasoningEfforts: ReadonlyArray<string>;
}

export interface CodexNativeProfilePolicy {
  readonly instanceId: ProviderInstanceId;
  readonly effectiveProfile: CodexEffectiveProfile;
  readonly authorizedChildProfile: CodexAuthorizedChildProfile;
  readonly maxWorkers: number;
  readonly maxResidentThreads: number;
  readonly appServerLaunchArgs: string;
}

export class CodexNativeProfileConfigurationError extends Schema.TaggedErrorClass<CodexNativeProfileConfigurationError>()(
  "CodexNativeProfileConfigurationError",
  {
    instanceId: ProviderInstanceId,
    issue: Schema.String,
  },
) {
  override get message(): string {
    return this.issue;
  }
}

export const CODEX_GLM53_INSTANCE_ID = ProviderInstanceId.make("codex_glm53");
export const CODEX_GLM53_MODEL = "z-ai/glm-5.3-flash";
export const CODEX_GLM53_MODEL_PROVIDER = "openrouter";
export const CODEX_GLM53_REASONING_EFFORT = "max";
export const CODEX_GLM53_REASONING_EFFORTS = ["high", "max"] as const;
export const CODEX_GLM53_MAX_WORKERS = 10;
export const CODEX_GLM53_MAX_RESIDENT_THREADS = CODEX_GLM53_MAX_WORKERS + 1;
export const CODEX_GLM53_MODEL_CATALOG_FILENAME = "glm53-model-catalog.json";

const GLM53_APP_SERVER_LAUNCH_ARGS = `--strict-config -c 'features.multi_agent_v2={ enabled = true, tool_namespace = "agents", max_concurrent_threads_per_session = ${CODEX_GLM53_MAX_RESIDENT_THREADS}, expose_spawn_agent_model_overrides = true }' -c 'shell_environment_policy={ inherit = "core", ignore_default_excludes = false }'`;

export const CODEX_GLM53_NATIVE_PROFILE: CodexNativeProfilePolicy = {
  instanceId: CODEX_GLM53_INSTANCE_ID,
  effectiveProfile: {
    modelProvider: CODEX_GLM53_MODEL_PROVIDER,
    model: CODEX_GLM53_MODEL,
    reasoningEffort: CODEX_GLM53_REASONING_EFFORT,
  },
  authorizedChildProfile: {
    modelProvider: CODEX_GLM53_MODEL_PROVIDER,
    model: CODEX_GLM53_MODEL,
    reasoningEfforts: CODEX_GLM53_REASONING_EFFORTS,
  },
  maxWorkers: CODEX_GLM53_MAX_WORKERS,
  maxResidentThreads: CODEX_GLM53_MAX_RESIDENT_THREADS,
  appServerLaunchArgs: GLM53_APP_SERVER_LAUNCH_ARGS,
};

export function codexNativeProfilePolicy(
  instanceId: ProviderInstanceId,
): CodexNativeProfilePolicy | undefined {
  return instanceId === CODEX_GLM53_INSTANCE_ID ? CODEX_GLM53_NATIVE_PROFILE : undefined;
}

export function codexNativeProfileSelectionIssue(
  policy: CodexNativeProfilePolicy,
  selection: ModelSelection | undefined,
): string | undefined {
  if (selection?.instanceId !== policy.instanceId) {
    return `Instance '${policy.instanceId}' requires its own model selection.`;
  }
  if (selection.model !== policy.effectiveProfile.model) {
    return `Instance '${policy.instanceId}' requires model '${policy.effectiveProfile.model}'.`;
  }
  const selectedEffort = getModelSelectionStringOptionValue(selection, "reasoningEffort");
  if (selectedEffort && !policy.authorizedChildProfile.reasoningEfforts.includes(selectedEffort)) {
    return `Instance '${policy.instanceId}' requires reasoning effort 'high' or 'max'.`;
  }
  return undefined;
}

export function codexNativeProfileExpectedParent(
  policy: CodexNativeProfilePolicy,
  selection: ModelSelection | undefined,
): CodexEffectiveProfile {
  return {
    ...policy.effectiveProfile,
    reasoningEffort:
      getModelSelectionStringOptionValue(selection, "reasoningEffort") ??
      policy.effectiveProfile.reasoningEffort,
  };
}

export const codexNativeProfileLaunchArgs = Effect.fn("codexNativeProfileLaunchArgs")(function* (
  policy: CodexNativeProfilePolicy | undefined,
  launchArgs: string,
  homePath?: string,
): Effect.fn.Return<string, CodexNativeProfileConfigurationError> {
  if (!policy) return launchArgs;
  const catalogPath = codexNativeProfileCatalogPath(policy, homePath);
  if (!catalogPath) {
    return yield* new CodexNativeProfileConfigurationError({
      instanceId: policy.instanceId,
      issue:
        codexNativeProfileHomeIssue(policy, homePath) ??
        `Instance '${policy.instanceId}' has an invalid Codex home path.`,
    });
  }
  const catalogConfig = `model_catalog_json=${JSON.stringify(catalogPath)}`;
  const quotedCatalogConfig = `"${catalogConfig
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("$", "\\$")
    .replaceAll("`", "\\`")}"`;
  return [launchArgs.trim(), policy.appServerLaunchArgs, "-c", quotedCatalogConfig]
    .filter(Boolean)
    .join(" ");
});

export function codexNativeProfileHomeIssue(
  policy: CodexNativeProfilePolicy,
  homePath?: string,
): string | undefined {
  const rawHomePath = homePath?.trim() ?? "";
  if (!rawHomePath) {
    return `Instance '${policy.instanceId}' requires a non-empty absolute Codex home path.`;
  }
  if (rawHomePath.includes("\0") || rawHomePath.includes("\r") || rawHomePath.includes("\n")) {
    return `Instance '${policy.instanceId}' has an unsafe Codex home path.`;
  }
  const expandedHomePath = expandHomePath(rawHomePath);
  if (!NodePath.isAbsolute(expandedHomePath)) {
    return `Instance '${policy.instanceId}' requires an absolute Codex home path.`;
  }
  const normalizedHomePath = NodePath.resolve(expandedHomePath);
  if (normalizedHomePath === NodePath.parse(normalizedHomePath).root) {
    return `Instance '${policy.instanceId}' cannot use a filesystem root as its Codex home.`;
  }
  return undefined;
}

export function codexNativeProfileCatalogPath(
  policy: CodexNativeProfilePolicy,
  homePath?: string,
): string | undefined {
  if (codexNativeProfileHomeIssue(policy, homePath)) return undefined;
  return NodePath.join(
    NodePath.resolve(expandHomePath(homePath!.trim())),
    CODEX_GLM53_MODEL_CATALOG_FILENAME,
  );
}

export function applyCodexNativeProfileModelCapabilities(
  instanceId: ProviderInstanceId,
  models: ReadonlyArray<ServerProviderModel>,
): ReadonlyArray<ServerProviderModel> {
  const policy = codexNativeProfilePolicy(instanceId);
  if (!policy) return models;
  return models.map((model) =>
    model.slug === policy.effectiveProfile.model
      ? {
          ...model,
          capabilities: createModelCapabilities({
            optionDescriptors: [
              {
                id: "reasoningEffort",
                label: "Reasoning",
                type: "select",
                options: [
                  {
                    id: "high",
                    label: "High",
                  },
                  {
                    id: policy.effectiveProfile.reasoningEffort,
                    label: "Max",
                    isDefault: true,
                  },
                ],
              },
            ],
          }),
        }
      : model,
  );
}
