import type { ProviderKind, ServerProvider } from "@t3tools/contracts";
import type { Stream } from "effect";
import type { ProviderAdapterError } from "./Errors.ts";
import type { ProviderAdapterShape } from "./Services/ProviderAdapter.ts";
import type { ServerProviderShape } from "./Services/ServerProvider.ts";

export type ProviderSnapshotSource = {
  readonly provider: ProviderKind;
  readonly getSnapshot: ServerProviderShape["getSnapshot"];
  readonly refresh: ServerProviderShape["refresh"];
  readonly streamChanges: Stream.Stream<ServerProvider>;
};

type BuiltInProviderServiceMap = Record<ProviderKind, ServerProviderShape>;
type BuiltInAdapterMap = {
  readonly codex: ProviderAdapterShape<ProviderAdapterError>;
  readonly claudeAgent: ProviderAdapterShape<ProviderAdapterError>;
  readonly opencode: ProviderAdapterShape<ProviderAdapterError>;
  readonly cursor?: ProviderAdapterShape<ProviderAdapterError>;
};

export const BUILT_IN_PROVIDER_ORDER = [
  "codex",
  "claudeAgent",
  "opencode",
  "cursor",
] as const satisfies ReadonlyArray<ProviderKind>;

export function createBuiltInProviderSources(
  services: BuiltInProviderServiceMap,
): ReadonlyArray<ProviderSnapshotSource> {
  return BUILT_IN_PROVIDER_ORDER.map((provider) => ({
    provider,
    getSnapshot: services[provider].getSnapshot,
    refresh: services[provider].refresh,
    streamChanges: services[provider].streamChanges,
  }));
}

export function createBuiltInAdapterList(
  adapters: BuiltInAdapterMap,
): ReadonlyArray<ProviderAdapterShape<ProviderAdapterError>> {
  return [
    adapters.codex,
    adapters.claudeAgent,
    adapters.opencode,
    ...(adapters.cursor ? [adapters.cursor] : []),
  ];
}
