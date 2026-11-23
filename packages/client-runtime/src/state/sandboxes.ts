import {
  EnvironmentId,
  WS_METHODS,
  type AgentctlSandbox,
  type AgentctlSandboxesSnapshot,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import * as SandboxEnvironments from "../sandboxes/environments.ts";
import { createEnvironmentRpcCommand } from "./runtime.ts";

/** A Sandbox and the host whose server manages it. */
export type HostedSandbox = AgentctlSandbox & { readonly hostEnvironmentId: EnvironmentId };

export interface SandboxHost {
  readonly hostEnvironmentId: EnvironmentId;
  readonly snapshot: AgentctlSandboxesSnapshot;
}

const NO_HOSTS: ReadonlyArray<SandboxHost> = [];

export function createSandboxAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | SandboxEnvironments.SandboxEnvironments | R, E>,
) {
  const hostsAtom = runtime.atom(
    Stream.unwrap(
      SandboxEnvironments.SandboxEnvironments.pipe(
        Effect.map((environments) =>
          SubscriptionRef.changes(environments.hosts).pipe(
            Stream.map((hosts): ReadonlyArray<SandboxHost> =>
              [...hosts].map(([hostEnvironmentId, snapshot]) => ({ hostEnvironmentId, snapshot })),
            ),
          ),
        ),
      ),
    ),
    { initialValue: NO_HOSTS },
  );
  /** Every host whose server manages Sandboxes, in the order the client met them. */
  const hostsValueAtom = Atom.make((get) =>
    Option.getOrElse(AsyncResult.value(get(hostsAtom)), () => NO_HOSTS),
  ).pipe(Atom.withLabel("sandboxes:hosts"));
  const sandboxesAtom = Atom.make((get): ReadonlyArray<HostedSandbox> =>
    get(hostsValueAtom).flatMap((host) =>
      host.snapshot.sandboxes.map((sandbox) => ({
        ...sandbox,
        hostEnvironmentId: host.hostEnvironmentId,
      })),
    ),
  ).pipe(Atom.withLabel("sandboxes:all"));

  const command = <TTag extends Parameters<typeof createEnvironmentRpcCommand>[1]["tag"]>(
    name: string,
    tag: TTag,
  ) => createEnvironmentRpcCommand(runtime, { label: `environment-data:sandboxes:${name}`, tag });

  return {
    hostsValueAtom,
    sandboxesAtom,
    start: command("start", WS_METHODS.agentctlStartSandbox),
    stop: command("stop", WS_METHODS.agentctlStopSandbox),
    remove: command("delete", WS_METHODS.agentctlDeleteSandbox),
    create: command("create", WS_METHODS.agentctlCreateSandbox),
    markSettingsSeeded: command("mark-settings-seeded", WS_METHODS.agentctlMarkSettingsSeeded),
    listManifests: command("list-manifests", WS_METHODS.agentctlListManifests),
    listManifestRoots: command("list-manifest-roots", WS_METHODS.agentctlListManifestRoots),
    refreshManifestRoots: command(
      "refresh-manifest-roots",
      WS_METHODS.agentctlRefreshManifestRoots,
    ),
    getSettings: command("get-settings", WS_METHODS.agentctlGetSettings),
    addManifestRoot: command("add-manifest-root", WS_METHODS.agentctlAddManifestRoot),
    removeManifestRoot: command("remove-manifest-root", WS_METHODS.agentctlRemoveManifestRoot),
    pullManifestRoots: command("pull-manifest-roots", WS_METHODS.agentctlPullManifestRoots),
  };
}
