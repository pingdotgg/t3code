// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { ServerProviderSkill } from "@t3tools/contracts";

/** Production filesystem probe injected into {@link parseClaudeReloadedSkills}. */
export const pathExistsSync = (candidate: string): boolean => NodeFS.existsSync(candidate);

/**
 * A skill entry as returned by the Claude Agent SDK's `reloadSkills` control
 * request. The SDK reuses its `SlashCommand` shape here; only the fields we map
 * are required.
 */
export type ClaudeReloadedSkill = {
  readonly name: string;
  readonly description?: string;
};

export type ClaudeSkillDiscoveryContext = {
  /**
   * Effective Claude config dir (the `CLAUDE_CONFIG_DIR` the CLI runs under):
   * `~/.claude` for the default home, or the configured home path directly.
   */
  readonly claudeConfigDir: string;
  /** Workspace the probe ran in, used to resolve project-scoped skills. */
  readonly cwd: string | undefined;
  readonly pathExists: (candidate: string) => boolean;
};

// `reloadSkills` appends the discovery scope to each description, e.g.
// "…reclaim disk space (user)". Strip it so it doesn't leak into the UI and
// reuse it as the skill's scope when we can't derive one from the filesystem.
const SCOPE_SUFFIX_PATTERN =
  /\s*\((user|project|local|plugin|builtin|bundled|system|managed|policy)\)\s*$/i;

function mapScopeToken(token: string): string {
  switch (token.toLowerCase()) {
    case "user":
      return "user";
    case "project":
    case "local":
      return "project";
    case "builtin":
    case "bundled":
    case "system":
      return "system";
    default:
      return token.toLowerCase();
  }
}

function nonEmpty(value: string | undefined): string | undefined {
  const candidate = value?.trim();
  return candidate ? candidate : undefined;
}

/**
 * Map the SDK's reloaded skill list into provider-snapshot skills, resolving a
 * real path on disk when possible and falling back to a constructed path (the
 * contract requires a non-empty `path`).
 */
export function parseClaudeReloadedSkills(
  skills: ReadonlyArray<ClaudeReloadedSkill> | undefined,
  ctx: ClaudeSkillDiscoveryContext,
): ReadonlyArray<ServerProviderSkill> {
  const byName = new Map<string, ServerProviderSkill>();

  for (const skill of skills ?? []) {
    const name = nonEmpty(skill.name);
    if (!name) {
      continue;
    }

    const key = name.toLowerCase();
    const existing = byName.get(key);
    if (existing) {
      // First entry wins; later duplicates only fill missing parsed metadata.
      const parsed = parseDescription(skill.description);
      if ((!existing.description && parsed.description) || (!existing.scope && parsed.scope)) {
        byName.set(key, {
          ...existing,
          ...(!existing.description && parsed.description
            ? { description: parsed.description }
            : {}),
          ...(!existing.scope && parsed.scope ? { scope: parsed.scope } : {}),
        });
      }
      continue;
    }

    byName.set(key, buildSkill(name, skill.description, ctx));
  }

  return [...byName.values()];
}

function parseDescription(raw: string | undefined): {
  readonly description: string | undefined;
  readonly scope: string | undefined;
} {
  const trimmed = raw?.trim() ?? "";
  const match = trimmed.match(SCOPE_SUFFIX_PATTERN);
  const scope = match ? mapScopeToken(match[1]!) : undefined;
  const description = nonEmpty(match ? trimmed.replace(SCOPE_SUFFIX_PATTERN, "") : trimmed);
  return { description, scope };
}

function buildSkill(
  name: string,
  rawDescription: string | undefined,
  ctx: ClaudeSkillDiscoveryContext,
): ServerProviderSkill {
  const { description, scope: suffixScope } = parseDescription(rawDescription);
  const configPath = NodePath.join(ctx.claudeConfigDir, "skills", name);

  let path = configPath;
  let scope = suffixScope;

  // Plugin-qualified names ("plugin:skill") don't correspond to a
  // "<root>/skills/<name>" directory, so skip the filesystem probe.
  if (!name.includes(":")) {
    const projectPath = ctx.cwd ? NodePath.join(ctx.cwd, ".claude", "skills", name) : undefined;
    if (projectPath && ctx.pathExists(projectPath)) {
      path = projectPath;
      scope = suffixScope ?? "project";
    } else if (ctx.pathExists(configPath)) {
      path = configPath;
      scope = suffixScope ?? "user";
    }
  }

  return {
    name,
    path,
    enabled: true,
    ...(description ? { description } : {}),
    ...(scope ? { scope } : {}),
  } satisfies ServerProviderSkill;
}
