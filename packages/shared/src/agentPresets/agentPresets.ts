import {
  agentSkillDigest,
  agentSkillDigestOf,
  AgentSkillResources,
  isAgentSkillStub,
  withoutAgentSkillTransportFields,
  McpGatewayProfile,
  type McpGatewayProfile as McpGatewayProfileType,
  TrimmedNonEmptyString,
  type AgentSkill,
  type AgentSkillResource,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { parse as parseYaml } from "yaml";
import { legacyAgentIcon } from "../agentIcons.ts";

const PresetSlug = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]*$/));

/** `presets/<id>/preset.json`. Profile fields reuse the agent schema so a preset always saves. */
export const AgentPresetManifest = Schema.Struct({
  id: PresetSlug,
  name: McpGatewayProfile.fields.name.check(Schema.isMaxLength(200)),
  description: Schema.String.check(Schema.isMaxLength(280)),
  color: Schema.String.check(Schema.isPattern(/^#[0-9a-fA-F]{6}$/)),
  icon: McpGatewayProfile.fields.icon,
  iconId: McpGatewayProfile.fields.iconId,
  tags: McpGatewayProfile.fields.tags,
  model: Schema.Struct({
    /** A provider driver such as `codex` or `claudeAgent`, or a provider display name. */
    provider: TrimmedNonEmptyString,
    model: TrimmedNonEmptyString,
    reasoningEffort: Schema.optional(TrimmedNonEmptyString),
  }),
  runtimeMode: McpGatewayProfile.fields.runtimeMode,
  interactionMode: McpGatewayProfile.fields.interactionMode,
  skills: Schema.Array(Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]*$/))),
  setupNotes: Schema.Array(TrimmedNonEmptyString),
});
export type AgentPresetManifest = typeof AgentPresetManifest.Type;

/** What to do with a preset skill when the library already has skills of the same name. */
export type PresetSkillChoice =
  | { readonly kind: "reuse"; readonly skillId: string }
  | { readonly kind: "update"; readonly skillId: string }
  | { readonly kind: "new" };

export interface AgentPresetSkill {
  readonly name: string;
  readonly description: string;
  readonly content: string;
  readonly resources: ReadonlyArray<AgentSkillResource>;
  /** Set by the picker for a same-name conflict; absent means `presetSkillConflicts`' default. */
  readonly choice?: PresetSkillChoice;
}

export interface AgentPreset extends Omit<AgentPresetManifest, "skills"> {
  readonly systemPrompt: string;
  readonly skills: ReadonlyArray<AgentPresetSkill>;
}

const decodeManifest = Schema.decodeUnknownSync(Schema.fromJsonString(AgentPresetManifest));
const decodeResources = Schema.decodeUnknownSync(AgentSkillResources);
const decodeSkillText = Schema.decodeUnknownSync(
  Schema.Struct({
    name: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
    description: Schema.String.check(Schema.isMaxLength(1024)),
    content: TrimmedNonEmptyString.check(Schema.isMaxLength(64_000)),
  }),
);

function frontmatter(markdown: string): Record<string, unknown> {
  const match = /^﻿?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown);
  if (!match) return {};
  const value: unknown = parseYaml(match[1] ?? "");
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function utf8Base64(text: string) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

function decodeSkill(name: string, files: Readonly<Record<string, string>>): AgentPresetSkill {
  const root = `skills/${name}/`;
  const content = files[`${root}SKILL.md`];
  if (content === undefined) throw new Error(`skill "${name}" is not in the skills pool`);
  try {
    const meta = frontmatter(content);
    const text = decodeSkillText({
      name: typeof meta.name === "string" && meta.name.trim() ? meta.name.trim() : name,
      description: typeof meta.description === "string" ? meta.description.trim() : "",
      content,
    });
    const resources = decodeResources(
      Object.keys(files)
        .filter((path) => path.startsWith(root) && path !== `${root}SKILL.md`)
        .sort()
        .map((path) => ({
          path: path.slice(root.length),
          contentBase64: utf8Base64(files[path]!),
          ...(files[path]!.startsWith("#!") ? { executable: true } : {}),
        })),
    );
    return { ...text, resources };
  } catch (cause) {
    throw new Error(`skill "${name}": ${cause instanceof Error ? cause.message : String(cause)}`, {
      cause,
    });
  }
}

/**
 * Decodes file text keyed by path under agentPresets/: `presets/<id>/…` and the
 * shared `skills/<name>/…` pool. Bundles carry UTF-8 text, so a script's
 * executable bit comes from its shebang, the only way it can run directly.
 */
export function decodeAgentPresets(files: Readonly<Record<string, string>>) {
  const skills = new Map<string, AgentPresetSkill>();
  const ids = Object.keys(files)
    .filter((path) => /^presets\/[^/]+\/preset\.json$/.test(path))
    .map((path) => path.split("/")[1]!)
    .sort();
  return ids.map((id): AgentPreset => {
    try {
      const { skills: names, ...manifest } = decodeManifest(files[`presets/${id}/preset.json`]);
      if (manifest.id !== id) throw new Error(`id "${manifest.id}" does not match its folder`);
      const systemPrompt = files[`presets/${id}/system-prompt.md`]?.trim();
      if (systemPrompt === undefined) throw new Error("missing system-prompt.md");
      if (systemPrompt.length > 32_000) throw new Error("system-prompt.md is too long");
      return {
        ...manifest,
        systemPrompt,
        skills: names.map((name) => {
          const skill = skills.get(name) ?? decodeSkill(name, files);
          skills.set(name, skill);
          return skill;
        }),
      };
    } catch (cause) {
      throw new Error(
        `Agent preset "${id}" is invalid: ${cause instanceof Error ? cause.message : String(cause)}`,
        { cause },
      );
    }
  });
}

function bundleKey(skill: Pick<AgentSkill, "content" | "resources">) {
  return JSON.stringify([
    skill.content.trim(),
    (skill.resources ?? [])
      .map((file) => [file.path, file.contentBase64, file.executable === true] as const)
      .sort(([a], [b]) => a.localeCompare(b)),
  ]);
}

/**
 * A library skill whose SKILL.md and files match exactly, whatever its name. Metadata stubs
 * compare by digest, so no body has to be fetched.
 */
export function findIdenticalSkill(
  library: ReadonlyArray<AgentSkill>,
  skill: Pick<AgentSkill, "content" | "resources">,
) {
  const key = bundleKey(skill);
  const digest = agentSkillDigest(skill);
  return library.find((candidate) =>
    isAgentSkillStub(candidate)
      ? agentSkillDigestOf(candidate) === digest
      : bundleKey(candidate) === key,
  );
}

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

export interface PresetSkillConflict {
  /** Index into the preset's skills. */
  readonly index: number;
  readonly name: string;
  /** Library skills with this name, most recently updated first. */
  readonly candidates: ReadonlyArray<AgentSkill>;
  readonly defaultChoice: PresetSkillChoice;
}

/**
 * Preset skills whose name matches library skills that differ from them. Identical skills, stubs
 * included, are reused without asking.
 */
export function presetSkillConflicts(
  library: ReadonlyArray<AgentSkill>,
  skills: ReadonlyArray<AgentPresetSkill>,
): ReadonlyArray<PresetSkillConflict> {
  return skills.flatMap((skill, index) => {
    if (findIdenticalSkill(library, skill)) return [];
    const candidates = library
      .filter((candidate) => sameName(candidate.name, skill.name))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const newest = candidates[0];
    if (!newest) return [];
    return [
      {
        index,
        name: skill.name,
        candidates,
        defaultChoice: { kind: "reuse", skillId: newest.skillId } as const,
      },
    ];
  });
}

/**
 * Adds preset skills to the library. Identical skills are reused; a same-named skill follows the
 * skill's `choice`, defaulting to reuse of the newest copy. `update` rewrites that skill in place
 * so agents that list its id get the preset text. Nothing is removed.
 */
export function addPresetSkills(
  library: ReadonlyArray<AgentSkill>,
  skills: ReadonlyArray<AgentPresetSkill>,
  options: { readonly now: string; readonly makeId: () => string },
) {
  const agentSkills = [...library];
  const skillIds = skills.map((skill) => {
    const existing = findIdenticalSkill(agentSkills, skill);
    if (existing) return existing.skillId;
    const choice = skill.choice ??
      presetSkillConflicts(agentSkills, [skill])[0]?.defaultChoice ?? { kind: "new" };
    const target =
      choice.kind === "new"
        ? undefined
        : agentSkills.findIndex((candidate) => candidate.skillId === choice.skillId);
    if (target !== undefined && target >= 0) {
      if (choice.kind === "reuse") return agentSkills[target]!.skillId;
      const { resources: _resources, ...current } = withoutAgentSkillTransportFields(
        agentSkills[target]!,
      );
      agentSkills[target] = {
        ...current,
        description: skill.description,
        content: skill.content,
        // Explicit, so a server keeping the stored files for an omitted field drops the old ones.
        resources: skill.resources,
        // The base revision this edit is made against; the server bumps it on save.
        revision: current.revision,
        updatedAt: options.now,
      };
      return current.skillId;
    }
    const created: AgentSkill = {
      skillId: options.makeId(),
      name: skill.name,
      description: skill.description,
      content: skill.content,
      ...(skill.resources.length ? { resources: skill.resources } : {}),
      revision: 1,
      createdAt: options.now,
      updatedAt: options.now,
    };
    agentSkills.push(created);
    return created.skillId;
  });
  return { agentSkills, skillIds: [...new Set(skillIds)] };
}

const slug = (text: string, pattern: RegExp, fallback: string) =>
  text
    .trim()
    .replace(pattern, "-")
    .replace(/-+/g, "-")
    .replace(/^[-._]+|-+$/g, "") || fallback;

const unique = (taken: Set<string>, base: string) => {
  let name = base;
  for (let n = 2; taken.has(name); n++) name = `${base}-${n}`;
  taken.add(name);
  return name;
};

/**
 * Writes agents and the library skills they use as the preset folder tree that
 * `decodeAgentPresets` reads, and checks the result decodes. Skill files must be UTF-8 text.
 */
export function exportAgentPresets(
  profiles: ReadonlyArray<McpGatewayProfileType>,
  library: ReadonlyArray<AgentSkill>,
): Record<string, string> {
  const files: Record<string, string> = {};
  const presetIds = new Set<string>();
  const skillFolders = new Map<string, string>();
  const takenFolders = new Set<string>();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const missing = new Map<string, string[]>();
  for (const profile of profiles) {
    for (const skillId of profile.skillIds ?? []) {
      const skill = library.find((candidate) => candidate.skillId === skillId);
      if (skill && !isAgentSkillStub(skill)) continue;
      const label = skill ? JSON.stringify(skill.name) : skillId;
      missing.set(label, [...(missing.get(label) ?? []), profile.name]);
    }
  }
  if (missing.size > 0) {
    const list = [...missing].map(([label, agents]) => `${label} (${agents.join(", ")})`);
    throw new Error(
      `Could not load skills: ${list.join(", ")}. Connect the machine that holds them, or remove them from these agents, then export again.`,
    );
  }
  const skillFolder = (skill: AgentSkill) => {
    const known = skillFolders.get(skill.skillId);
    if (known) return known;
    const folder = unique(takenFolders, slug(skill.name, /[^A-Za-z0-9._-]+/g, "skill"));
    skillFolders.set(skill.skillId, folder);
    files[`skills/${folder}/SKILL.md`] = `${skill.content.trim()}\n`;
    for (const resource of skill.resources ?? []) {
      try {
        const bytes = Uint8Array.from(atob(resource.contentBase64), (char) => char.charCodeAt(0));
        files[`skills/${folder}/${resource.path}`] = decoder.decode(bytes);
      } catch {
        throw new Error(
          `Skill "${skill.name}" has ${resource.path}, which is not text and cannot be exported.`,
        );
      }
    }
    return folder;
  };
  for (const profile of profiles) {
    const id = unique(presetIds, slug(profile.name.toLowerCase(), /[^a-z0-9-]+/g, "agent"));
    const provider = profile.providerLabel ?? profile.modelSelection?.instanceId;
    const model = profile.modelLabel ?? profile.modelSelection?.model;
    if (!provider || !model) throw new Error(`Agent "${profile.name}" has no model to export.`);
    const skills = (profile.skillIds ?? []).map((skillId) =>
      skillFolder(library.find((candidate) => candidate.skillId === skillId)!),
    );
    files[`presets/${id}/preset.json`] = `${JSON.stringify(
      {
        id,
        name: profile.name,
        description: profile.description ?? "",
        color: profile.color ?? "#8b8b8b",
        ...(profile.iconId
          ? { icon: profile.icon ?? legacyAgentIcon(profile.iconId), iconId: profile.iconId }
          : profile.icon && { icon: profile.icon }),
        ...(profile.tags?.length ? { tags: profile.tags } : {}),
        model: {
          provider,
          model,
          ...(profile.reasoningEffort && { reasoningEffort: profile.reasoningEffort }),
        },
        runtimeMode: profile.runtimeMode,
        interactionMode: profile.interactionMode,
        skills,
        setupNotes: [],
      },
      null,
      2,
    )}\n`;
    files[`presets/${id}/system-prompt.md`] = `${profile.systemPrompt?.trim() ?? ""}\n`;
  }
  decodeAgentPresets(files);
  return files;
}

/**
 * Text files of an archive holding a preset tree, at its root or inside one wrapping folder.
 * Directory entries are skipped; a file that is not UTF-8 fails.
 */
export function agentPresetFilesFromArchive(
  entries: Iterable<readonly [string, Uint8Array]>,
): Record<string, string> {
  const files = [...entries].filter(([path]) => !path.endsWith("/"));
  const root = files
    .map(([path]) => /^(.*?)(?:presets|skills)\//.exec(path)?.[1])
    .find((prefix) => prefix !== undefined);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  return Object.fromEntries(
    files.flatMap(([path, bytes]) => {
      if (root === undefined || !path.startsWith(root)) return [];
      try {
        return [[path.slice(root.length), decoder.decode(bytes)] as const];
      } catch {
        throw new Error(`${path} is not a text file.`);
      }
    }),
  );
}
