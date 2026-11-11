import {
  type ModelSelection,
  type ProviderInstanceId,
  type ServerProvider,
  type ServerSettings,
  textGeneratorForSelection,
} from "@t3tools/contracts";
import * as Equal from "effect/Equal";

export const SCOPED_MODEL_SETTING_KEYS = [
  "defaultModelSelection",
  "fallbackModelSelection",
  "textGenerationModelSelection",
  "sourceControlWriterModelSelection",
  "reviewGuideModelSelection",
  "speechPostProcessingModelSelection",
] as const;
export type ScopedModelSettingKey = (typeof SCOPED_MODEL_SETTING_KEYS)[number];

export const isScopedModelSettingKey = (key: string): key is ScopedModelSettingKey =>
  (SCOPED_MODEL_SETTING_KEYS as readonly string[]).includes(key);

export const supportsScopedTextGenerator = (key: ScopedModelSettingKey) =>
  key === "textGenerationModelSelection" ||
  key === "sourceControlWriterModelSelection" ||
  key === "speechPostProcessingModelSelection";

export const scopedTextGenerator = (
  settings: Pick<ServerSettings, "textGenerators">,
  instanceId: ProviderInstanceId,
  key: ScopedModelSettingKey,
) =>
  key === "defaultModelSelection" || key === "fallbackModelSelection"
    ? undefined
    : textGeneratorForSelection(settings, instanceId);

export interface ScopedModelEnvironment {
  readonly providers: readonly ServerProvider[];
  readonly settings: Pick<ServerSettings, "textGenerators">;
}

/** Instance IDs and names are machine-local; only a reported ChatGPT login identifies the account. */
const chatGptAccount = ({ driver, auth }: ServerProvider) =>
  driver === "codex" &&
  auth.status === "authenticated" &&
  auth.type === "chatgpt" &&
  auth.email &&
  auth.workspaceId
    ? `${auth.email.toLowerCase()}\n${auth.workspaceId}`
    : null;

const find = (providers: readonly ServerProvider[], instanceId: ProviderInstanceId) =>
  providers.find((provider) => provider.instanceId === instanceId);

/** Keeps an ID the destination has; remaps an absent one only through a unique ChatGPT account. */
export function resolveScopedModelInstanceId(
  instanceId: ProviderInstanceId,
  sourceEnvironment: Pick<ScopedModelEnvironment, "providers">,
  destination: ScopedModelEnvironment,
  key: ScopedModelSettingKey = "defaultModelSelection",
): ProviderInstanceId | null {
  if (
    key === "reviewGuideModelSelection" &&
    scopedTextGenerator(destination.settings, instanceId, key)
  )
    return null;
  if (find(destination.providers, instanceId)) return instanceId;
  const source = find(sourceEnvironment.providers, instanceId);
  const account = source ? chatGptAccount(source) : null;
  if (account === null) return null;
  const matches = (providers: readonly ServerProvider[]) =>
    providers.filter((provider) => chatGptAccount(provider) === account);
  const [match, ...rest] = matches(destination.providers);
  // A text generator takes precedence over a provider instance with its ID.
  return match &&
    rest.length === 0 &&
    matches(sourceEnvironment.providers).length === 1 &&
    scopedTextGenerator(destination.settings, match.instanceId, key) === undefined
    ? match.instanceId
    : null;
}

export function scopedModelSelectionsEqual(
  first: ModelSelection | null,
  firstEnvironment: ScopedModelEnvironment,
  second: ModelSelection | null,
  secondEnvironment: ScopedModelEnvironment,
  key: ScopedModelSettingKey = "defaultModelSelection",
): boolean {
  if (first === null || second === null) return first === second;
  const firstGenerator = scopedTextGenerator(firstEnvironment.settings, first.instanceId, key);
  const secondGenerator = scopedTextGenerator(secondEnvironment.settings, second.instanceId, key);
  if (firstGenerator || secondGenerator) {
    return (
      supportsScopedTextGenerator(key) &&
      firstGenerator?.kind === secondGenerator?.kind &&
      firstGenerator?.baseUrl === secondGenerator?.baseUrl &&
      Equal.equals(first, second)
    );
  }
  const sameInstance =
    first.instanceId === second.instanceId ||
    (resolveScopedModelInstanceId(first.instanceId, firstEnvironment, secondEnvironment, key) ===
      second.instanceId &&
      resolveScopedModelInstanceId(second.instanceId, secondEnvironment, firstEnvironment, key) ===
        first.instanceId);
  return sameInstance && Equal.equals({ ...first, instanceId: second.instanceId }, second);
}
