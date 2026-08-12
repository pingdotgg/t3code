import type { ServerProviderDraft } from "./providerSnapshot.ts";
import { discoverAgentSkills } from "./Drivers/AgentSkills.ts";
import * as Effect from "effect/Effect";

/** Attach portable `.agents/skills` entries to a provider snapshot draft. */
export const augmentProviderSnapshotWithAgentSkills = Effect.fn(
  "augmentProviderSnapshotWithAgentSkills",
)(function* (
  draft: ServerProviderDraft,
  cwd?: string,
  options?: { readonly homeDirectory?: string },
) {
  const skills = yield* discoverAgentSkills(cwd, options);
  return skills.length === 0 ? draft : { ...draft, skills };
});
