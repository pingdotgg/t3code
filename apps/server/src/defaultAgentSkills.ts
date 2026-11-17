import { defaultAgentSkills } from "@t3tools/shared/agentPresets";
import { readAgentPresetSkillFiles } from "@t3tools/shared/agentPresetSkillFiles";
import * as Effect from "effect/Effect";

import * as ServerSettings from "./serverSettings.ts";

/** Inlined by the server build, which has no skills pool on disk. */
declare const __T3CODE_AGENT_PRESET_SKILL_FILES__: Record<string, string> | undefined;

/** Gives a brand-new library the shipped default skills, so every client and agent sees them. */
export const seed = Effect.fn("DefaultAgentSkills.seed")(
  function* () {
    const serverSettings = yield* ServerSettings.ServerSettingsService;
    yield* serverSettings.ready;
    const agentSkills = defaultAgentSkills(
      yield* serverSettings.getSettings,
      typeof __T3CODE_AGENT_PRESET_SKILL_FILES__ === "undefined"
        ? readAgentPresetSkillFiles()
        : __T3CODE_AGENT_PRESET_SKILL_FILES__,
    );
    if (agentSkills.length === 0) return;
    // Merged as a replica, so a library that gained an item meanwhile keeps every edit and deletion.
    yield* serverSettings.updateSettings({ agentSkills }, true);
  },
  Effect.catchCause((cause) => Effect.logWarning("Failed to seed default agent skills.", cause)),
);
