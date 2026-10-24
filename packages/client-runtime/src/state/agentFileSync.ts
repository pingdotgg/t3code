// @effect-diagnostics globalTimers:off -- The relay follows the client lifecycle outside an Effect runtime.
import { AgentFileSyncError, WS_METHODS } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import type { Atom } from "effect/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  executeAtomQuery,
  runAtomCommand,
  squashAtomCommandFailure,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "./runtime.ts";

const isSyncError = Schema.is(AgentFileSyncError);

export function createAgentFileSyncAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    links: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "agent-file-sync:links",
      tag: WS_METHODS.agentFileSyncLinks,
      staleTimeMs: 5_000,
      idleTtlMs: 15_000,
    }),
    subscribe: createEnvironmentRpcCommand(runtime, {
      label: "agent-file-sync:subscribe",
      tag: WS_METHODS.agentFileSyncSubscribe,
    }),
    refresh: createEnvironmentRpcCommand(runtime, {
      label: "agent-file-sync:refresh",
      tag: WS_METHODS.agentFileSyncRefresh,
    }),
    manage: createEnvironmentRpcCommand(runtime, {
      label: "agent-file-sync:manage",
      tag: WS_METHODS.agentFileSyncManage,
    }),
    check: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "agent-file-sync:check",
      tag: WS_METHODS.agentFileSyncCheck,
      staleTimeMs: 0,
      idleTtlMs: 0,
    }),
    list: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "agent-file-sync:list",
      tag: WS_METHODS.agentFileSyncList,
      staleTimeMs: 15_000,
      idleTtlMs: 30_000,
    }),
    export: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "agent-file-sync:export",
      tag: WS_METHODS.agentFileSyncExport,
      staleTimeMs: 0,
      idleTtlMs: 0,
    }),
    preview: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "agent-file-sync:preview",
      tag: WS_METHODS.agentFileSyncPreview,
      staleTimeMs: 0,
      idleTtlMs: 0,
    }),
    apply: createEnvironmentRpcCommand(runtime, {
      label: "agent-file-sync:apply",
      tag: WS_METHODS.agentFileSyncApply,
    }),
    undo: createEnvironmentRpcCommand(runtime, {
      label: "agent-file-sync:undo",
      tag: WS_METHODS.agentFileSyncUndo,
    }),
  };
}

/** One client relays changes over its existing authenticated environment connections. */
export function startAgentFileSyncRelay<R, E>(
  registry: import("effect/reactivity").AtomRegistry.AtomRegistry,
  atoms: ReturnType<typeof createAgentFileSyncAtoms<R, E>>,
  environmentIds: readonly import("@t3tools/contracts").EnvironmentId[],
) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const options = { reportFailure: false, refresh: true, signal: controller.signal };
  const pass = async () => {
    try {
      for (const environmentId of environmentIds) {
        if (controller.signal.aborted) return;
        if (!registry.get(atoms.refresh.permissionAtom(environmentId))) continue;
        const links = await executeAtomQuery(
          registry,
          atoms.links({ environmentId, input: {} }),
          options,
        );
        if (links._tag === "Failure") continue;
        for (const link of links.value) {
          if (controller.signal.aborted) return;
          if (link.paused || !environmentIds.includes(link.sourceEnvironmentId)) continue;
          const source = await executeAtomQuery(
            registry,
            atoms.check({
              environmentId: link.sourceEnvironmentId,
              input: { selection: link.selection, revision: link.revision },
            }),
            options,
          );
          if (controller.signal.aborted) return;
          if (source._tag === "Failure") {
            const error = squashAtomCommandFailure(source);
            if (isSyncError(error))
              await runAtomCommand(
                registry,
                atoms.manage,
                {
                  environmentId,
                  input: {
                    id: link.id,
                    generation: link.generation,
                    action: "pause",
                    error: error.message.slice(0, 2000),
                  },
                },
                { reportFailure: false },
              );
            continue;
          }
          await runAtomCommand(
            registry,
            atoms.refresh,
            {
              environmentId,
              input: { id: link.id, generation: link.generation, bundle: source.value.bundle },
            },
            { reportFailure: false },
          );
        }
      }
    } catch {
      // Connection teardown can invalidate atoms between the query and command. Retry on the next pass.
    } finally {
      if (!controller.signal.aborted) timer = setTimeout(() => void pass(), 15_000);
    }
  };
  void pass();
  return () => {
    controller.abort();
    clearTimeout(timer);
  };
}
