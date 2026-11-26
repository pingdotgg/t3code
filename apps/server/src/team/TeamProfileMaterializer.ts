// @effect-diagnostics nodeBuiltinImport:off -- Uses lstat/symlink/chmod for isolated team profile skill precedence and 0600 ephemeral tokens.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import type {
  ProviderDriverKind,
  ProviderInstanceId,
  TeamId,
  TeamPreprompt,
  TeamProviderLeaseResponse,
  TeamSkill,
} from "@t3tools/contracts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

class TeamProfileMaterializerIoError extends Schema.TaggedError<TeamProfileMaterializerIoError>()(
  "TeamProfileMaterializerIoError",
  { cause: Schema.Defect() },
) {}

const encodeJsonUnknown = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

import { resolveAntigravityInstanceDirectories } from "../provider/antigravityAuthSupport.ts";

const TEAM_PROFILE_MARKER_FILENAME = ".t3-team-profile.json";
const TEAM_ANTIGRAVITY_SKILLS_DIRNAME = "team-skills";
export const TEAM_ANTIGRAVITY_OAUTH_TOKEN_FILENAME = "antigravity-oauth-token";

export interface TeamProfilePaths {
  readonly profileDir: string;
  readonly skillsDir: string;
  readonly instructionFile: string | null;
  readonly ephemeralTokenFiles: ReadonlyArray<string>;
}

/**
 * Resolves the isolated profile root for a virtual `team:<teamId>:<sourceInstanceId>` instance.
 * Antigravity uses its native SHA-256 instance profile directory so `AntigravityDriver` reads it
 * directly as `GEMINI_HOME`. Codex, Claude, and other drivers live under `<stateDir>/team-profiles/`.
 * Personal `~/.gemini`, `~/.codex`, and `~/.claude` are NEVER modified.
 */
export const resolveTeamProfilePaths = Effect.fn("TeamProfileMaterializer.resolvePaths")(
  function* (input: {
    readonly stateDir: string;
    readonly teamId: TeamId;
    readonly virtualInstanceId: ProviderInstanceId;
    readonly driver: ProviderDriverKind;
  }): Effect.fn.Return<TeamProfilePaths, never, Digest.Digest | Path.Path> {
    const path = yield* Path.Path;
    if (input.driver === "antigravity") {
      const dirs = yield* resolveAntigravityInstanceDirectories(
        input.stateDir,
        input.virtualInstanceId,
      );
      return {
        profileDir: dirs.profile,
        skillsDir: path.join(dirs.profile, TEAM_ANTIGRAVITY_SKILLS_DIRNAME),
        instructionFile: path.join(dirs.profile, "GEMINI.md"),
        ephemeralTokenFiles: [
          path.join(dirs.profile, TEAM_ANTIGRAVITY_OAUTH_TOKEN_FILENAME),
          path.join(dirs.profile, "antigravity-acp", "acp_token.json"),
        ],
      };
    }

    const hash = NodeCrypto.createHash("sha256")
      .update(`${input.teamId}:${input.virtualInstanceId}`, "utf8")
      .digest("hex")
      .slice(0, 24);
    const profileDir = path.join(input.stateDir, "team-profiles", input.driver, hash);

    if (input.driver === "codex") {
      return {
        profileDir,
        skillsDir: path.join(profileDir, "skills"),
        instructionFile: path.join(profileDir, "AGENTS.md"),
        // Codex uses in-memory CodexManagedTokenBroker; zero token file on disk.
        ephemeralTokenFiles: [],
      };
    }
    if (input.driver === "claudeAgent") {
      return {
        profileDir,
        skillsDir: path.join(profileDir, "skills"),
        instructionFile: path.join(profileDir, "CLAUDE.md"),
        ephemeralTokenFiles: [path.join(profileDir, ".credentials.json")],
      };
    }
    return {
      profileDir,
      skillsDir: path.join(profileDir, TEAM_ANTIGRAVITY_SKILLS_DIRNAME),
      instructionFile: null,
      ephemeralTokenFiles: [],
    };
  },
);

/**
 * Selects enabled team skills for a specific driver. When both `"*"` and a driver-specific skill
 * share a slug, the driver-specific skill wins.
 */
function selectTeamSkillsForDriver(
  skills: ReadonlyArray<TeamSkill>,
  driver: ProviderDriverKind,
): ReadonlyArray<TeamSkill> {
  const bySlug = new Map<string, TeamSkill>();
  for (const skill of skills) {
    if (!skill.enabled) continue;
    if (skill.providerDriver !== "*" && skill.providerDriver !== driver) continue;
    const key = skill.slug.toLowerCase();
    const existing = bySlug.get(key);
    if (!existing || (existing.providerDriver === "*" && skill.providerDriver === driver)) {
      bySlug.set(key, skill);
    }
  }
  return [...bySlug.values()].sort((a, b) => a.slug.localeCompare(b.slug));
}

export function selectTeamPrepromptsForDriver(
  preprompts: ReadonlyArray<TeamPreprompt>,
  driver: ProviderDriverKind,
  scope: "thread" | "turn",
): ReadonlyArray<TeamPreprompt> {
  return preprompts
    .filter(
      (item) =>
        item.enabled &&
        item.injectionScope === scope &&
        (item.providerDriver === "*" || item.providerDriver === driver),
    )
    .toSorted((a, b) => {
      // Wildcard team instructions first, then driver-specific refinements.
      if (a.providerDriver !== b.providerDriver) {
        if (a.providerDriver === "*") return -1;
        if (b.providerDriver === "*") return 1;
      }
      return a.name.localeCompare(b.name) || a.createdAt.localeCompare(b.createdAt);
    });
}

export function renderTeamPrepromptsMarkdown(preprompts: ReadonlyArray<TeamPreprompt>): string {
  if (preprompts.length === 0) return "";
  return preprompts.map((item) => `## ${item.name}\n\n${item.content.trim()}`).join("\n\n");
}

async function writeSecureTokenFile(
  filePath: string,
  contents: string,
  platform: NodeJS.Platform,
): Promise<void> {
  await NodeFSP.mkdir(NodePath.dirname(filePath), { recursive: true, mode: 0o700 });
  const tempPath = `${filePath}.tmp-${NodeCrypto.randomUUID()}`;
  try {
    await NodeFSP.writeFile(tempPath, contents, { encoding: "utf8", mode: 0o600 });
    if (platform !== "win32") {
      await NodeFSP.chmod(tempPath, 0o600);
    }
    await NodeFSP.rename(tempPath, filePath);
    if (platform !== "win32") {
      await NodeFSP.chmod(filePath, 0o600);
    }
  } catch (error) {
    await NodeFSP.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function syncDirectoryPersonalSkillLinks(input: {
  readonly targetSkillsDir: string;
  readonly personalSkillsDir: string;
  readonly teamSlugsLower: ReadonlySet<string>;
  readonly platform: NodeJS.Platform;
}): Promise<void> {
  const personalStat = await NodeFSP.stat(input.personalSkillsDir).catch(() => undefined);
  if (!personalStat?.isDirectory()) return;
  const personalEntries = await NodeFSP.readdir(input.personalSkillsDir).catch(
    () => [] as string[],
  );
  const linkType = input.platform === "win32" ? "junction" : "dir";
  for (const entry of personalEntries) {
    if (entry.startsWith(".")) continue;
    // Team skills strictly take precedence on slug collision.
    if (input.teamSlugsLower.has(entry.toLowerCase())) continue;
    const sourcePath = NodePath.join(input.personalSkillsDir, entry);
    const linkPath = NodePath.join(input.targetSkillsDir, entry);
    const existing = await NodeFSP.lstat(linkPath).catch(() => undefined);
    if (existing !== undefined) continue;
    await NodeFSP.symlink(sourcePath, linkPath, linkType).catch(() => undefined);
  }
}

/**
 * Materializes team skills and `"thread"`-scoped pre-prompts exclusively inside `<teamProfile>`.
 * Personal config directories (`~/.gemini`, `~/.codex`, `~/.claude`) are never modified; personal
 * skills stay accessible alongside team skills with team skills winning on slug/name collision.
 */
export const materializeTeamProfileAssets = Effect.fn("TeamProfileMaterializer.materializeAssets")(
  function* (input: {
    readonly stateDir: string;
    readonly teamId: TeamId;
    readonly virtualInstanceId: ProviderInstanceId;
    readonly driver: ProviderDriverKind;
    readonly skills: ReadonlyArray<TeamSkill>;
    readonly preprompts: ReadonlyArray<TeamPreprompt>;
    readonly revision: number;
    readonly userHome?: string;
  }): Effect.fn.Return<TeamProfilePaths, never, Digest.Digest | FileSystem.FileSystem | Path.Path> {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const platform = yield* HostProcess.Platform;
    const userHome = input.userHome ?? (yield* HostProcess.HomeDirectory);
    const paths = yield* resolveTeamProfilePaths({
      stateDir: input.stateDir,
      teamId: input.teamId,
      virtualInstanceId: input.virtualInstanceId,
      driver: input.driver,
    });

    const activeSkills = selectTeamSkillsForDriver(input.skills, input.driver);
    const threadPreprompts = selectTeamPrepromptsForDriver(
      input.preprompts,
      input.driver,
      "thread",
    );
    const teamSlugsLower = new Set(activeSkills.map((skill) => skill.slug.toLowerCase()));

    yield* Effect.tryPromise({
      try: async () => {
        await NodeFSP.mkdir(paths.profileDir, { recursive: true, mode: 0o700 });
        if (platform !== "win32") {
          await NodeFSP.chmod(paths.profileDir, 0o700).catch(() => undefined);
        }

        // Write team profile marker so upstream Antigravity profile linking preserves team-owned files.
        await NodeFSP.writeFile(
          NodePath.join(paths.profileDir, TEAM_PROFILE_MARKER_FILENAME),
          `${encodeJsonUnknown({
            teamId: input.teamId,
            virtualInstanceId: input.virtualInstanceId,
            driver: input.driver,
            revision: input.revision,
          })}\n`,
          "utf8",
        );

        // Rebuild skills directory cleanly so deleted/disabled team skills vanish immediately.
        await NodeFSP.rm(paths.skillsDir, { recursive: true, force: true });
        await NodeFSP.mkdir(paths.skillsDir, { recursive: true, mode: 0o700 });

        for (const skill of activeSkills) {
          const skillDir = NodePath.join(paths.skillsDir, skill.slug);
          await NodeFSP.mkdir(skillDir, { recursive: true, mode: 0o700 });
          await NodeFSP.writeFile(NodePath.join(skillDir, "SKILL.md"), skill.skillMd, "utf8");
          for (const ref of skill.references) {
            const refPath = NodePath.join(skillDir, ...ref.path.split("/"));
            await NodeFSP.mkdir(NodePath.dirname(refPath), { recursive: true, mode: 0o700 });
            await NodeFSP.writeFile(refPath, ref.content, "utf8");
          }
        }

        if (input.driver === "antigravity") {
          // Register `<teamProfile>/team-skills` FIRST in `<teamProfile>/config/skills.json`,
          // followed by the user's personal `~/.gemini` skill directories (read-only).
          const configDir = NodePath.join(paths.profileDir, "config");
          await NodeFSP.mkdir(configDir, { recursive: true, mode: 0o700 });
          const personalConfigSkills = NodePath.join(userHome, ".gemini", "config", "skills");
          const personalCliSkills = NodePath.join(userHome, ".gemini", "antigravity-cli", "skills");
          const entries: Array<{ readonly path: string }> = [{ path: paths.skillsDir }];
          for (const candidate of [personalConfigSkills, personalCliSkills]) {
            const stat = await NodeFSP.stat(candidate).catch(() => undefined);
            if (stat?.isDirectory()) {
              entries.push({ path: candidate });
            }
          }
          const skillsConfigPath = NodePath.join(configDir, "skills.json");
          const existingSkillsConfig = await NodeFSP.lstat(skillsConfigPath).catch(() => undefined);
          if (existingSkillsConfig?.isSymbolicLink()) {
            await NodeFSP.unlink(skillsConfigPath);
          }
          await NodeFSP.writeFile(skillsConfigPath, `${encodeJsonUnknown({ entries })}\n`, "utf8");
        } else if (input.driver === "codex") {
          await syncDirectoryPersonalSkillLinks({
            targetSkillsDir: paths.skillsDir,
            personalSkillsDir: NodePath.join(userHome, ".codex", "skills"),
            teamSlugsLower,
            platform,
          });
        } else if (input.driver === "claudeAgent") {
          await syncDirectoryPersonalSkillLinks({
            targetSkillsDir: paths.skillsDir,
            personalSkillsDir: NodePath.join(userHome, ".claude", "skills"),
            teamSlugsLower,
            platform,
          });
        }
      },
      catch: (cause) => new TeamProfileMaterializerIoError({ cause }),
    }).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("TeamProfileMaterializer.materializeAssets failed", {
          virtualInstanceId: input.virtualInstanceId,
          driver: input.driver,
          cause,
        }),
      ),
    );

    if (paths.instructionFile !== null) {
      const instructionPath = paths.instructionFile;
      // Remove any pre-existing symlink pointing to personal `~/.gemini/GEMINI.md` before writing!
      yield* Effect.tryPromise({
        try: async () => {
          const stat = await NodeFSP.lstat(instructionPath).catch(() => undefined);
          if (stat?.isSymbolicLink()) {
            await NodeFSP.unlink(instructionPath);
          }
        },
        catch: () => undefined,
      }).pipe(Effect.ignore);

      const rendered = renderTeamPrepromptsMarkdown(threadPreprompts);
      if (rendered.length > 0) {
        const header = `<!-- Managed by T3 Code Teams (revision ${input.revision}). Do not edit manually. -->\n\n`;
        yield* writeFileStringAtomically({
          filePath: instructionPath,
          contents: `${header}${rendered}\n`,
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
          Effect.catch((cause) =>
            Effect.logWarning("TeamProfileMaterializer.writeInstructionFile failed", {
              instructionPath,
              cause,
            }),
          ),
        );
      } else {
        yield* fs.remove(instructionPath, { force: true }).pipe(Effect.ignore);
      }
    }

    return paths;
  },
);

/**
 * Materializes an ephemeral OAuth access token into an isolated team profile with `chmod 0600`.
 * Strictly strips `refresh_token` / `refreshToken`. Codex never writes any token to disk.
 */
export const materializeEphemeralLeaseToken = Effect.fn(
  "TeamProfileMaterializer.materializeEphemeralLeaseToken",
)(function* (input: {
  readonly stateDir: string;
  readonly teamId: TeamId;
  readonly virtualInstanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly lease: TeamProviderLeaseResponse;
}): Effect.fn.Return<void, never, Digest.Digest | Path.Path> {
  if (input.driver === "codex") {
    // Codex receives its leased access token strictly in memory via CodexManagedTokenBroker.
    return;
  }
  const platform = yield* HostProcess.Platform;
  const paths = yield* resolveTeamProfilePaths({
    stateDir: input.stateDir,
    teamId: input.teamId,
    virtualInstanceId: input.virtualInstanceId,
    driver: input.driver,
  });

  if (input.driver === "antigravity") {
    const tokenPath = NodePath.join(paths.profileDir, TEAM_ANTIGRAVITY_OAUTH_TOKEN_FILENAME);
    // Explicitly omit `refresh_token` so refresh credentials never touch a teammate's disk.
    const payload = {
      token: {
        access_token: input.lease.accessToken,
        token_type: input.lease.tokenType,
        expiry: input.lease.expiresAt,
        expires_in: input.lease.expiresInSeconds,
      },
      auth_method: input.lease.authMethod ?? "oauth-personal",
      ...(input.lease.email ? { id_token_email: input.lease.email } : {}),
    };
    yield* Effect.tryPromise({
      try: () => writeSecureTokenFile(tokenPath, `${encodeJsonUnknown(payload)}\n`, platform),
      catch: (cause) => new TeamProfileMaterializerIoError({ cause }),
    }).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("TeamProfileMaterializer.writeAntigravityLeaseToken failed", {
          virtualInstanceId: input.virtualInstanceId,
          cause,
        }),
      ),
    );
    return;
  }

  if (input.driver === "claudeAgent") {
    const credentialsPath = NodePath.join(paths.profileDir, ".credentials.json");
    const expiresAtMs = Date.parse(input.lease.expiresAt);
    const nowMs = yield* Clock.currentTimeMillis;
    // Explicitly omit `refreshToken`.
    const payload = {
      claudeAiOauth: {
        accessToken: input.lease.accessToken,
        expiresAt: Number.isFinite(expiresAtMs) ? expiresAtMs : nowMs + 3_600_000,
      },
    };
    yield* Effect.tryPromise({
      try: () => writeSecureTokenFile(credentialsPath, `${encodeJsonUnknown(payload)}\n`, platform),
      catch: (cause) => new TeamProfileMaterializerIoError({ cause }),
    }).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("TeamProfileMaterializer.writeClaudeLeaseToken failed", {
          virtualInstanceId: input.virtualInstanceId,
          cause,
        }),
      ),
    );
  }
});

/** Purges all transient ephemeral token files from a virtual team profile (idle/disconnect/leave/403). */
export const purgeEphemeralLeaseTokens = Effect.fn(
  "TeamProfileMaterializer.purgeEphemeralLeaseTokens",
)(function* (input: {
  readonly stateDir: string;
  readonly teamId: TeamId;
  readonly virtualInstanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
}): Effect.fn.Return<void, never, Digest.Digest | Path.Path> {
  const paths = yield* resolveTeamProfilePaths(input);
  yield* Effect.tryPromise({
    try: async () => {
      for (const tokenPath of paths.ephemeralTokenFiles) {
        await NodeFSP.rm(tokenPath, { force: true }).catch(() => undefined);
      }
    },
    catch: () => undefined,
  }).pipe(Effect.ignore);
});

/** Purges the entire isolated profile directory when a member leaves or is revoked from a team. */
export const purgeTeamProfileDirectory = Effect.fn(
  "TeamProfileMaterializer.purgeTeamProfileDirectory",
)(function* (input: {
  readonly stateDir: string;
  readonly teamId: TeamId;
  readonly virtualInstanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
}): Effect.fn.Return<void, never, Digest.Digest | Path.Path> {
  const paths = yield* resolveTeamProfilePaths(input);
  yield* Effect.tryPromise({
    try: () => NodeFSP.rm(paths.profileDir, { recursive: true, force: true }),
    catch: () => undefined,
  }).pipe(Effect.ignore);
});
