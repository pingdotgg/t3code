/**
 * providerSkills — project-scoped skill discovery for the `$` composer picker.
 *
 * `ServerProvider.skills` on the provider snapshot is machine-scoped: the
 * server scans it once per provider instance against its own cwd, which a
 * packaged desktop build sets to the user's home directory. Skills are
 * project-scoped, so that snapshot reports user-scope skills only and is empty
 * on a machine that keeps none there.
 *
 * This family asks per project instead, and the server resolves the project's
 * workspace root (or a persisted thread's worktree) before scanning. Keying on
 * the project means a DRAFT thread resolves too, which is when the picker
 * matters most. Consumers fall
 * back to the snapshot when the query has no data yet, so the picker degrades
 * to the old behaviour rather than to nothing.
 *
 * @module state/providerSkills
 */
import { WS_METHODS } from "@t3tools/contracts";

import type { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

export function createProviderSkillsEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    workspaceSkills: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:providers:workspace-skills",
      tag: WS_METHODS.providersWorkspaceSkills,
      // A skill set changes when files change on disk, not per keystroke, so a
      // generous stale window keeps the picker instant without pinning the
      // scan in memory for threads the user has moved away from.
      staleTimeMs: 30_000,
      idleTtlMs: 5 * 60_000,
    }),
  };
}
