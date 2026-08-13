import type { ServerProviderDraft } from "./providerSnapshot.ts";
import { discoverUserAgentSkills } from "./Drivers/AgentSkills.ts";
import * as Effect from "effect/Effect";

/**
 * Attach user-scoped portable `.agents/skills` entries to a provider snapshot
 * draft. Project-scoped skills are resolved per active workspace via the
 * `projects.listAgentSkills` RPC and merged on the client, not baked into this
 * environment-level snapshot.
 */
export const augmentProviderSnapshotWithAgentSkills = Effect.fn(
  "augmentProviderSnapshotWithAgentSkills",
)(function* (draft: ServerProviderDraft, options?: { readonly homeDirectory?: string }) {
  const skills = yield* discoverUserAgentSkills(options);
  return skills.length === 0 ? draft : { ...draft, skills };
});
