/**
 * Project mirroring state: live per-project sync status plus the commands
 * behind the setup flow. The GUI orchestrates setup through its existing
 * environment connections — `mirror.createPeerCredential` against the host,
 * `mirror.attach`/`mirror.detach` against the origin — and never carries
 * file data itself.
 */
import { WS_METHODS, type MirrorProjectStatus } from "@t3tools/contracts";
import * as Stream from "effect/Stream";
import type { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

export type MirrorStatusByProject = Readonly<Record<string, MirrorProjectStatus>>;

export function createMirrorEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  /**
   * Latest status per mirrored project on an environment. Subscribe with
   * `{ input: {} }` for every mirrored project, or narrow to one with
   * `{ input: { projectId } }`.
   */
  const statusByProject = createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "environment-data:mirror:status",
    tag: WS_METHODS.subscribeMirrorStatus,
    transform: (stream) =>
      Stream.scan(
        stream,
        {} as MirrorStatusByProject,
        (byProject, status) =>
          ({
            ...byProject,
            [status.projectId]: status,
          }) satisfies MirrorStatusByProject,
      ),
  });

  const requestSync = createEnvironmentRpcCommand(runtime, {
    label: "environment-data:mirror:request-sync",
    tag: WS_METHODS.mirrorRequestSync,
  });

  /** Host side of the setup flow: mint the peer's mirror:sync bearer. */
  const createPeerCredential = createEnvironmentRpcCommand(runtime, {
    label: "environment-data:mirror:create-peer-credential",
    tag: WS_METHODS.mirrorCreatePeerCredential,
  });

  /** Origin side of the setup flow: persist the link and start the agent. */
  const attach = createEnvironmentRpcCommand(runtime, {
    label: "environment-data:mirror:attach",
    tag: WS_METHODS.mirrorAttach,
  });

  const detach = createEnvironmentRpcCommand(runtime, {
    label: "environment-data:mirror:detach",
    tag: WS_METHODS.mirrorDetach,
  });

  /** Origin side: every folder this environment shares to a host. */
  const listLinks = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:mirror:list-links",
    tag: WS_METHODS.mirrorListLinks,
    staleTimeMs: 5_000,
    idleTtlMs: 60_000,
  });

  return { statusByProject, requestSync, createPeerCredential, attach, detach, listLinks };
}
