import { WS_METHODS } from "@t3tools/contracts";
import { Atom, AsyncResult } from "effect/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  squashAtomCommandFailure,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

export function createExtensionEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const state = createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "environment-data:extensions",
    tag: WS_METHODS.extensionsSubscribe,
  });
  const catalog = Atom.family((idsKey: string) => {
    const ids = JSON.parse(idsKey) as readonly import("@t3tools/contracts").EnvironmentId[];
    return Atom.make((get) =>
      ids.flatMap((environmentId) =>
        AsyncResult.getOrElse(get(state({ environmentId, input: {} })), () => []).map((entry) => ({
          environmentId,
          entry,
        })),
      ),
    );
  });
  return {
    state,
    catalog,
    install: createEnvironmentRpcCommand(runtime, {
      label: "extensions:install",
      tag: WS_METHODS.extensionsInstall,
    }),
    manage: createEnvironmentRpcCommand(runtime, {
      label: "extensions:manage",
      tag: WS_METHODS.extensionsManage,
    }),
    settings: createEnvironmentRpcCommand(runtime, {
      label: "extensions:settings",
      tag: WS_METHODS.extensionsSettings,
    }),
    invoke: createEnvironmentRpcCommand(runtime, {
      label: "extensions:invoke",
      tag: WS_METHODS.extensionsInvoke,
    }),
    panel: createEnvironmentRpcCommand(runtime, {
      label: "extensions:panel",
      tag: WS_METHODS.extensionsPanel,
    }),
  };
}

export function extensionCommandValue<A, E>(
  result: import("./runtime.ts").AtomCommandResult<A, E>,
): A {
  if (result._tag === "Success") return result.value;
  throw squashAtomCommandFailure(result);
}

export function extensionFailureMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Extension request failed.";
}

export function extensionSettingsPages(
  entries: readonly import("@t3tools/contracts").ExtensionInfo[],
) {
  return entries
    .filter((entry) => entry.enabled)
    .flatMap((entry) => (entry.manifest.settingsPages ?? []).map((page) => ({ entry, page })));
}
