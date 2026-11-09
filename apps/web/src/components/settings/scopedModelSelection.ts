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

export interface ScopedModelEnvironment {
  readonly providers: readonly ServerProvider[];
  readonly settings: Pick<ServerSettings, "textGenerators">;
}

const identity = ({ auth }: ServerProvider) => [
  auth.type,
  auth.email?.toLowerCase(),
  auth.workspaceId,
];

/** Unreported login, email, or workspace is unknown, not a conflict. */
const knownConflict = (first: ServerProvider, second: ServerProvider) =>
  first.driver !== second.driver ||
  identity(first).some((value, index) => {
    const other = identity(second)[index];
    return value && other && value !== other;
  });

/** Instance IDs and names are machine-local; only a reported ChatGPT login identifies the account. */
const chatGptAccount = (provider: ServerProvider) =>
  provider.driver === "codex" &&
  provider.auth.status === "authenticated" &&
  provider.auth.type === "chatgpt" &&
  provider.auth.email &&
  provider.auth.workspaceId
    ? JSON.stringify(identity(provider))
    : null;

const find = (providers: readonly ServerProvider[], instanceId: ProviderInstanceId) =>
  providers.find((provider) => provider.instanceId === instanceId);

export function resolveScopedModelInstanceId(
  instanceId: ProviderInstanceId,
  sourceEnvironment: Pick<ScopedModelEnvironment, "providers">,
  destination: ScopedModelEnvironment,
  peers: readonly ServerProvider[] = [],
): ProviderInstanceId | null {
  const source = find(sourceEnvironment.providers, instanceId);
  if (!source) return null;
  const sameId = find(destination.providers, instanceId);
  const compatible = (provider: ServerProvider) =>
    !peers.some((peer) => knownConflict(peer, provider));
  if (sameId && !knownConflict(source, sameId) && compatible(sameId)) return instanceId;
  const account = chatGptAccount(source);
  if (account === null) return null;
  const matches = (providers: readonly ServerProvider[]) =>
    providers.filter((provider) => chatGptAccount(provider) === account);
  const [match, ...rest] = matches(destination.providers);
  // A text generator takes precedence over a provider instance with its ID.
  return match &&
    rest.length === 0 &&
    matches(sourceEnvironment.providers).length === 1 &&
    compatible(match) &&
    textGeneratorForSelection(destination.settings, match.instanceId) === undefined
    ? match.instanceId
    : null;
}

export function scopedModelSelectionsEqual(
  first: ModelSelection | null,
  firstEnvironment: ScopedModelEnvironment,
  second: ModelSelection | null,
  secondEnvironment: ScopedModelEnvironment,
): boolean {
  if (first === null || second === null) return first === second;
  const firstProvider = find(firstEnvironment.providers, first.instanceId);
  const secondProvider = find(secondEnvironment.providers, second.instanceId);
  const sameInstance =
    first.instanceId === second.instanceId
      ? !(firstProvider && secondProvider && knownConflict(firstProvider, secondProvider))
      : resolveScopedModelInstanceId(first.instanceId, firstEnvironment, secondEnvironment) ===
          second.instanceId &&
        resolveScopedModelInstanceId(second.instanceId, secondEnvironment, firstEnvironment) ===
          first.instanceId;
  return sameInstance && Equal.equals({ ...first, instanceId: second.instanceId }, second);
}
