import {
  agentSkillDigestOf,
  withoutAgentSkillTransportFields,
  type AgentSkill,
  type AgentTemplateRecord,
  type McpGatewayProfile,
} from "@t3tools/contracts";
import {
  addPresetSkills,
  agentTemplateDigest,
  agentTemplateRecord,
  type AgentPreset,
  type AgentPresetSkill,
  type AgentTemplate,
} from "./agentPresets.ts";
import { AGENT_TEMPLATES_SHIPPED_AT } from "./agentTemplateDates.ts";

interface AgentLibrary {
  readonly agentSkills: ReadonlyArray<AgentSkill>;
  readonly mcpGatewayProfiles: ReadonlyArray<McpGatewayProfile>;
}

/** A library item whose built-in template changed. `modified` copies are merged, never replaced. */
export type AgentTemplateUpdate =
  | {
      readonly kind: "agent";
      readonly modified: boolean;
      readonly profile: McpGatewayProfile;
      readonly template: AgentPreset & { readonly template: AgentTemplate };
    }
  | {
      readonly kind: "skill";
      readonly modified: boolean;
      readonly skill: AgentSkill;
      readonly template: AgentPresetSkill & { readonly template: AgentTemplate };
    };

const nameKey = (name: string) => name.trim().toLowerCase();

const skillNames = (profile: McpGatewayProfile, skills: ReadonlyArray<AgentSkill>) =>
  (profile.skillIds ?? []).map(
    (skillId) => skills.find((skill) => skill.skillId === skillId)?.name ?? skillId,
  );

const profileTemplateDigest = (profile: McpGatewayProfile, skills: ReadonlyArray<AgentSkill>) =>
  agentTemplateDigest(profile.systemPrompt ?? "", skillNames(profile, skills));

// Seeded with a fixed id at revision 1; any save bumps the revision.
const isUneditedSeededSkill = (skill: AgentSkill) =>
  skill.skillId.startsWith("t3-default-") && skill.revision === 1;

/**
 * Whether a copy is behind its template, and whether its user edited it. Only the template's date
 * in the repo counts: a copy is behind once the template changed after the date the copy last
 * took, however recently its user edited it. A copy from before records took the shipping date.
 */
function templateState(
  record: AgentTemplateRecord | undefined,
  template: AgentTemplate,
  contentDigest: () => string,
  unedited = false,
): { readonly modified: boolean } | null {
  const templateTime = Date.parse(template.updatedAt);
  const syncedTime = Date.parse(record?.syncedAt ?? AGENT_TEMPLATES_SHIPPED_AT);
  if (templateTime < syncedTime) return null;
  const digest = contentDigest();
  if (record?.mergingFrom !== undefined && record.mergingFrom === digest) return { modified: true };
  if (templateTime === syncedTime || digest === template.digest) return null;
  return { modified: record ? digest !== record.digest : !unedited };
}

/** `presets` are the built-ins, marked by `withAgentTemplates`. */
export function agentTemplateUpdates(
  library: AgentLibrary,
  presets: ReadonlyArray<AgentPreset>,
): ReadonlyArray<AgentTemplateUpdate> {
  const skillTemplates = new Map(
    presets
      .flatMap((preset) => preset.skills)
      .flatMap((skill) => (skill.template ? [[nameKey(skill.template.id), skill] as const] : [])),
  );
  const agents = library.mcpGatewayProfiles.flatMap((profile): AgentTemplateUpdate[] => {
    const preset = presets.find((item) =>
      profile.template
        ? item.id === profile.template.id
        : nameKey(item.name) === nameKey(profile.name),
    );
    if (!preset?.template) return [];
    const state = templateState(profile.template, preset.template, () =>
      profileTemplateDigest(profile, library.agentSkills),
    );
    return state
      ? [{ kind: "agent", ...state, profile, template: { ...preset, template: preset.template } }]
      : [];
  });
  const skills = library.agentSkills.flatMap((skill): AgentTemplateUpdate[] => {
    const template = skillTemplates.get(nameKey(skill.template?.id ?? skill.name));
    if (!template?.template) return [];
    const state = templateState(
      skill.template,
      template.template,
      () => agentSkillDigestOf(skill),
      isUneditedSeededSkill(skill),
    );
    return state
      ? [{ kind: "skill", ...state, skill, template: { ...template, template: template.template } }]
      : [];
  });
  return [...agents, ...skills].sort((a, b) => Number(a.modified) - Number(b.modified));
}

/** Replaces an unedited copy with its current template. An agent gets the template's skills. */
export function applyAgentTemplateUpdate(
  library: AgentLibrary,
  update: AgentTemplateUpdate,
  options: { readonly now: string; readonly makeId: () => string },
): AgentLibrary {
  if (update.kind === "skill") {
    const { template } = update;
    return {
      mcpGatewayProfiles: library.mcpGatewayProfiles,
      agentSkills: library.agentSkills.map((skill) => {
        if (skill.skillId !== update.skill.skillId) return skill;
        const { resources: _resources, ...current } = withoutAgentSkillTransportFields(skill);
        return {
          ...current,
          description: template.description,
          content: template.content,
          // Explicit, so a server keeping the stored files for an omitted field drops the old ones.
          resources: template.resources,
          template: agentTemplateRecord(template.template),
          updatedAt: options.now,
        };
      }),
    };
  }
  const added = addPresetSkills(library.agentSkills, update.template.skills, options);
  return {
    agentSkills: added.agentSkills,
    mcpGatewayProfiles: library.mcpGatewayProfiles.map((profile) =>
      profile.profileId === update.profile.profileId
        ? {
            ...profile,
            systemPrompt: update.template.systemPrompt,
            skillIds: added.skillIds,
            template: agentTemplateRecord(update.template.template),
            updatedAt: options.now,
          }
        : profile,
    ),
  };
}

/**
 * Points an edited copy at the current template once a chat to merge it has started. The copy's
 * digest is kept too, so the update stays listed until that chat saves a changed copy.
 */
export function markAgentTemplateMerged(
  library: AgentLibrary,
  update: AgentTemplateUpdate,
  now: string,
): AgentLibrary {
  const template = {
    ...agentTemplateRecord(update.template.template),
    mergingFrom:
      update.kind === "agent"
        ? profileTemplateDigest(update.profile, library.agentSkills)
        : agentSkillDigestOf(update.skill),
  };
  return update.kind === "agent"
    ? {
        agentSkills: library.agentSkills,
        mcpGatewayProfiles: library.mcpGatewayProfiles.map((profile) =>
          profile.profileId === update.profile.profileId
            ? { ...profile, template, updatedAt: now }
            : profile,
        ),
      }
    : {
        mcpGatewayProfiles: library.mcpGatewayProfiles,
        agentSkills: library.agentSkills.map((skill) =>
          skill.skillId === update.skill.skillId ? { ...skill, template, updatedAt: now } : skill,
        ),
      };
}

const decodeText = (contentBase64: string) => {
  try {
    const bytes = Uint8Array.from(atob(contentBase64), (char) => char.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
};

const MERGE_RULES = `The user edited their copy after installing it, so it was not replaced. The template text it was installed from is not recorded: anything in their copy that the latest template lacks is either their change or an older template line, so keep it unless the template clearly replaces it.

1. Compare their copy with the latest template below.
2. Merge the template's new and changed guidance into their copy, keeping their additions, removals and wording.
3. Show the merged result and a short list of what you took from the template and what you kept, then wait for approval.`;

/** The opening message of a chat that merges the current template into an edited copy. */
export function agentTemplateMergePrompt(
  update: AgentTemplateUpdate,
  library: AgentLibrary,
  /** The skill with its body and files, when they could be loaded. */
  fullSkill?: AgentSkill,
) {
  if (update.kind === "agent") {
    const { profile, template } = update;
    return `Merge the latest built-in "${template.name}" agent template into my agent "${profile.name}" (profileId ${profile.profileId}).

${MERGE_RULES}
4. Once approved, save it with t3_update_agent: patch.systemPrompt, and patch.skillIds only if its skills change (t3_list_skills gives their ids). Change nothing else.

<current_system_prompt>
${profile.systemPrompt?.trim() ?? ""}
</current_system_prompt>

<current_skills>${skillNames(profile, library.agentSkills).join(", ")}</current_skills>

<latest_template_system_prompt>
${template.systemPrompt}
</latest_template_system_prompt>

<latest_template_skills>${template.skills.map((skill) => skill.name).join(", ")}</latest_template_skills>`;
  }
  const { skill, template } = update;
  const current = fullSkill && !fullSkill.contentOmitted ? fullSkill : undefined;
  const currentFiles = new Map(
    (current?.resources ?? []).map((file) => [file.path, file.contentBase64]),
  );
  const changedFiles = template.resources.filter(
    (file) => currentFiles.get(file.path) !== file.contentBase64,
  );
  const files = changedFiles
    .map((file) => {
      const text = decodeText(file.contentBase64);
      return text === null
        ? `<latest_template_file path="${file.path}" binary="true" />`
        : `<latest_template_file path="${file.path}">\n${text}\n</latest_template_file>`;
    })
    .join("\n\n");
  return `Merge the latest built-in "${template.name}" skill template into my skill "${skill.name}" (skillId ${skill.skillId}).

${MERGE_RULES}
4. Once approved, save it with t3_update_skill: patch.content and patch.description, and patch.resources only if its files change (it replaces the whole list, so start from the current files t3_list_skills returns). Change nothing else.

${
  current
    ? `<current_skill_md>\n${current.content}\n</current_skill_md>`
    : "Read their current SKILL.md and files with t3_list_skills."
}

<latest_template_description>${template.description}</latest_template_description>

<latest_template_skill_md>
${template.content}
</latest_template_skill_md>${
    files
      ? `\n\nTemplate files that differ from their copy (unchanged files are omitted):\n\n${files}`
      : ""
  }`;
}
