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
import * as Semaphore from "effect/Semaphore";

class TeamProfileMaterializerIoError extends Schema.TaggedError<TeamProfileMaterializerIoError>()(
  "TeamProfileMaterializerIoError",
  { cause: Schema.Defect() },
) {}

const encodeJsonUnknown = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeProfileMarker = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      assetsHash: Schema.optionalKey(Schema.String),
    }),
  ),
);
const decodeAntigravityPluginPreferences = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      plugins: Schema.optional(
        Schema.Record(Schema.String, Schema.Struct({ enabled: Schema.optional(Schema.Boolean) })),
      ),
    }),
  ),
);

import { resolveAntigravityInstanceDirectories } from "../provider/antigravityAuthSupport.ts";
import {
  TEAM_ANTIGRAVITY_OAUTH_TOKEN_FILENAME,
  TEAM_PROFILE_MARKER_FILENAME,
  getTeamHarnessProfile,
  type HarnessPersonalSkillLayout,
} from "./harnessProfiles.ts";
import { validateTeamSkillPayload } from "./TeamSkillValidation.ts";

export { TEAM_ANTIGRAVITY_OAUTH_TOKEN_FILENAME };

const profileMaterializeLocks = new Map<string, Semaphore.Semaphore>();
function getProfileMaterializeLock(profileDir: string): Semaphore.Semaphore {
  let lock = profileMaterializeLocks.get(profileDir);
  if (!lock) {
    lock = Semaphore.makeUnsafe(1);
    profileMaterializeLocks.set(profileDir, lock);
  }
  return lock;
}

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
    const spec = getTeamHarnessProfile(input.driver);
    const profileDir =
      spec.profileStorage === "antigravity-native"
        ? (yield* resolveAntigravityInstanceDirectories(input.stateDir, input.virtualInstanceId))
            .profile
        : path.join(
            input.stateDir,
            "team-profiles",
            input.driver,
            NodeCrypto.createHash("sha256")
              .update(`${input.teamId}:${input.virtualInstanceId}`, "utf8")
              .digest("hex")
              .slice(0, 24),
          );

    return {
      profileDir,
      skillsDir: path.join(profileDir, spec.skillsSubdir),
      instructionFile:
        spec.threadInstructionFilename === null
          ? null
          : path.join(profileDir, spec.threadInstructionFilename),
      ephemeralTokenFiles: spec.ephemeralTokenRelativePaths.map((segments) =>
        path.join(profileDir, ...segments),
      ),
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

async function ensureContainedRealDirectory(rootRealDir: string, dirPath: string): Promise<string> {
  assertPathContainedWithin(rootRealDir, dirPath);
  const existing = await NodeFSP.lstat(dirPath).catch(() => undefined);
  if (existing !== undefined) {
    if (existing.isSymbolicLink()) {
      await NodeFSP.unlink(dirPath);
    } else if (!existing.isDirectory()) {
      await NodeFSP.rm(dirPath, { recursive: true, force: true });
    }
  }
  await NodeFSP.mkdir(dirPath, { recursive: true, mode: 0o700 });
  const postStat = await NodeFSP.lstat(dirPath);
  if (postStat.isSymbolicLink() || !postStat.isDirectory()) {
    throw new Error(`Refusing non-directory or symlink parent inside team profile: ${dirPath}`);
  }
  const realDir = await NodeFSP.realpath(dirPath);
  assertPathContainedWithin(rootRealDir, realDir);
  return realDir;
}

async function syncAntigravityPersonalConfigAndPlugins(input: {
  readonly profileDir: string;
  readonly skillsDir: string;
  readonly userHome: string;
  readonly layout: Extract<
    HarnessPersonalSkillLayout,
    { readonly kind: "antigravity-config-and-plugins" }
  >;
  readonly platform: NodeJS.Platform;
}): Promise<void> {
  // Validate every parent directory inside `<teamProfile>` against symlinks before any host-side
  // writes so a sandboxed agent can never redirect writes outside the isolated profile.
  const realProfileDir = await NodeFSP.realpath(input.profileDir);
  const configDir = await ensureContainedRealDirectory(
    realProfileDir,
    NodePath.join(realProfileDir, "config"),
  );

  // Register `<teamProfile>/team-skills` FIRST in `<teamProfile>/config/skills.json`,
  // followed by the user's personal `~/.gemini` skill directories (read-only).
  const entries: Array<{ readonly path: string }> = [{ path: input.skillsDir }];
  for (const segments of input.layout.personalSkillRelativeDirs) {
    const candidate = NodePath.join(input.userHome, ...segments);
    const stat = await NodeFSP.stat(candidate).catch(() => undefined);
    if (stat?.isDirectory()) {
      entries.push({ path: candidate });
    }
  }
  const skillsConfigPath = NodePath.join(configDir, "skills.json");
  assertPathContainedWithin(configDir, skillsConfigPath);
  const existingSkillsConfig = await NodeFSP.lstat(skillsConfigPath).catch(() => undefined);
  if (existingSkillsConfig?.isSymbolicLink()) {
    await NodeFSP.unlink(skillsConfigPath);
  } else if (existingSkillsConfig !== undefined && !existingSkillsConfig.isFile()) {
    await NodeFSP.rm(skillsConfigPath, { recursive: true, force: true });
  }
  const nextSkillsConfig = `${encodeJsonUnknown({ entries })}\n`;
  const currentSkillsConfig = await NodeFSP.readFile(skillsConfigPath, "utf8").catch(
    () => undefined,
  );
  if (currentSkillsConfig !== nextSkillsConfig) {
    await NodeFSP.writeFile(skillsConfigPath, nextSkillsConfig, "utf8");
  }

  // Mirror enabled personal plugins from `~/.gemini/config/plugins/*` into `<teamProfile>/config/plugins/*`
  // via symlinks/junctions without ever modifying `~/.gemini`. Team skills still win via first-wins scan order.
  const personalConfigPath = NodePath.join(
    input.userHome,
    ...input.layout.personalConfigRelativePath,
  );
  const personalConfigRaw = await NodeFSP.readFile(personalConfigPath, "utf8").catch(
    () => undefined,
  );
  const parsedPrefs =
    personalConfigRaw === undefined
      ? undefined
      : decodeAntigravityPluginPreferences(personalConfigRaw);
  const disabledPlugins = new Set(
    Object.entries(
      (parsedPrefs?._tag === "Some" ? parsedPrefs.value.plugins : undefined) ?? {},
    ).flatMap(([name, pref]) => (pref.enabled === false ? [name] : [])),
  );

  const personalPluginsDir = NodePath.join(
    input.userHome,
    ...input.layout.personalPluginsRelativeDir,
  );
  const desiredPlugins = new Map<string, string>();
  const personalPluginsStat = await NodeFSP.stat(personalPluginsDir).catch(() => undefined);
  if (personalPluginsStat?.isDirectory()) {
    const pluginEntries = await NodeFSP.readdir(personalPluginsDir).catch(() => [] as string[]);
    for (const entry of pluginEntries) {
      if (entry.startsWith(".") || disabledPlugins.has(entry)) continue;
      const sourcePath = NodePath.join(personalPluginsDir, entry);
      const entryStat = await NodeFSP.stat(sourcePath).catch(() => undefined);
      if (!entryStat?.isDirectory()) continue;
      desiredPlugins.set(entry, sourcePath);
    }
  }

  // Always create `<teamProfile>/config/plugins` as a real contained directory (even when empty)
  // so bwrap can lock `<teamProfile>/config` read-only and stale/shadowing entries are purged.
  const targetPluginsDir = await ensureContainedRealDirectory(
    configDir,
    NodePath.join(configDir, "plugins"),
  );
  const existingEntries = await NodeFSP.readdir(targetPluginsDir).catch(() => [] as string[]);
  const linkType = input.platform === "win32" ? "junction" : "dir";
  for (const existing of existingEntries) {
    const entryPath = NodePath.join(targetPluginsDir, existing);
    assertPathContainedWithin(targetPluginsDir, entryPath);
    const stat = await NodeFSP.lstat(entryPath).catch(() => undefined);
    if (stat === undefined) continue;
    if (!stat.isSymbolicLink()) {
      await NodeFSP.rm(entryPath, { recursive: true, force: true }).catch(() => undefined);
      continue;
    }
    const expectedTarget = desiredPlugins.get(existing);
    if (expectedTarget === undefined) {
      await NodeFSP.unlink(entryPath).catch(() => undefined);
      continue;
    }
    const currentTarget = await NodeFSP.readlink(entryPath).catch(() => undefined);
    if (
      currentTarget === undefined ||
      NodePath.resolve(targetPluginsDir, currentTarget) !== NodePath.resolve(expectedTarget)
    ) {
      await NodeFSP.unlink(entryPath).catch(() => undefined);
    }
  }

  for (const [pluginName, sourcePath] of desiredPlugins) {
    const linkPath = NodePath.join(targetPluginsDir, pluginName);
    assertPathContainedWithin(targetPluginsDir, linkPath);
    const existing = await NodeFSP.lstat(linkPath).catch(() => undefined);
    if (existing !== undefined) continue;
    await NodeFSP.symlink(sourcePath, linkPath, linkType).catch(() => undefined);
  }
}

function assertPathContainedWithin(rootDir: string, candidatePath: string): void {
  const resolvedRoot = NodePath.resolve(rootDir);
  const resolvedCandidate = NodePath.resolve(candidatePath);
  const prefix = resolvedRoot.endsWith(NodePath.sep)
    ? resolvedRoot
    : `${resolvedRoot}${NodePath.sep}`;
  if (!resolvedCandidate.startsWith(prefix)) {
    throw new Error(`Refusing to write outside isolated team skills directory: ${candidatePath}`);
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
    const spec = getTeamHarnessProfile(input.driver);
    const paths = yield* resolveTeamProfilePaths({
      stateDir: input.stateDir,
      teamId: input.teamId,
      virtualInstanceId: input.virtualInstanceId,
      driver: input.driver,
    });

    const selectedSkills = selectTeamSkillsForDriver(input.skills, input.driver);
    const activeSkills: Array<TeamSkill> = [];
    for (const skill of selectedSkills) {
      const validated = yield* Effect.result(
        validateTeamSkillPayload({
          slug: skill.slug,
          providerDriver: skill.providerDriver,
          skillMd: skill.skillMd,
          references: skill.references,
          enabled: skill.enabled,
        }),
      );
      if (validated._tag === "Failure") {
        yield* Effect.logWarning("TeamProfileMaterializer skipped invalid remote team skill", {
          virtualInstanceId: input.virtualInstanceId,
          slug: skill.slug,
          reason: validated.failure.message,
        });
        continue;
      }
      activeSkills.push({
        ...skill,
        slug: validated.success.slug as TeamSkill["slug"],
        skillMd: validated.success.skillMd,
        references: validated.success.references,
      });
    }

    const threadPreprompts = selectTeamPrepromptsForDriver(
      input.preprompts,
      input.driver,
      "thread",
    );
    const teamSlugsLower = new Set(activeSkills.map((skill) => skill.slug.toLowerCase()));
    const assetsHash = NodeCrypto.createHash("sha256")
      .update(
        encodeJsonUnknown({
          revision: input.revision,
          skills: activeSkills.map((s) => ({
            slug: s.slug,
            skillMd: s.skillMd,
            references: s.references,
          })),
          preprompts: threadPreprompts.map((p) => ({
            name: p.name,
            content: p.content,
          })),
        }),
        "utf8",
      )
      .digest("hex");

    const lock = getProfileMaterializeLock(paths.profileDir);
    return yield* lock.withPermits(1)(
      Effect.gen(function* () {
        const alreadyUpToDate = yield* Effect.tryPromise({
          try: async () => {
            const markerRaw = await NodeFSP.readFile(
              NodePath.join(paths.profileDir, TEAM_PROFILE_MARKER_FILENAME),
              "utf8",
            );
            const markerOpt = decodeProfileMarker(markerRaw);
            if (markerOpt._tag !== "Some" || markerOpt.value.assetsHash !== assetsHash) {
              return false;
            }
            const skillsStat = await NodeFSP.stat(paths.skillsDir);
            if (!skillsStat.isDirectory()) return false;
            if (paths.instructionFile !== null) {
              const expectsInstruction = threadPreprompts.length > 0;
              const hasInstruction = await NodeFSP.stat(paths.instructionFile)
                .then((s) => s.isFile())
                .catch(() => false);
              if (expectsInstruction !== hasInstruction) return false;
            }
            return true;
          },
          catch: () => false,
        }).pipe(Effect.orElseSucceed(() => false));

        if (alreadyUpToDate) {
          // Keep personal plugin/skill links fresh even when team assetsHash has not changed.
          if (spec.personalSkillLayout.kind === "antigravity-config-and-plugins") {
            const layout = spec.personalSkillLayout;
            yield* Effect.tryPromise({
              try: () =>
                syncAntigravityPersonalConfigAndPlugins({
                  profileDir: paths.profileDir,
                  skillsDir: paths.skillsDir,
                  userHome,
                  layout,
                  platform,
                }),
              catch: (cause) => new TeamProfileMaterializerIoError({ cause }),
            }).pipe(
              Effect.catch((cause) =>
                Effect.logWarning(
                  "TeamProfileMaterializer.syncAntigravityPersonalConfigAndPlugins failed",
                  {
                    virtualInstanceId: input.virtualInstanceId,
                    cause,
                  },
                ),
              ),
            );
          }
          return paths;
        }

        let skillsMaterialized = true;
        yield* Effect.tryPromise({
          try: async () => {
            await NodeFSP.mkdir(paths.profileDir, { recursive: true, mode: 0o700 });
            if (platform !== "win32") {
              await NodeFSP.chmod(paths.profileDir, 0o700).catch(() => undefined);
            }

            // Stage skills directory in a sibling temp folder and swap atomically so active agents
            // never observe an empty or half-written team skills directory during sync.
            const stagingSkillsDir = `${paths.skillsDir}.tmp-${NodeCrypto.randomUUID()}`;
            const backupSkillsDir = `${paths.skillsDir}.old-${NodeCrypto.randomUUID()}`;
            await NodeFSP.mkdir(stagingSkillsDir, { recursive: true, mode: 0o700 });
            try {
              for (const skill of activeSkills) {
                const skillDir = NodePath.join(stagingSkillsDir, skill.slug);
                assertPathContainedWithin(stagingSkillsDir, skillDir);
                await NodeFSP.mkdir(skillDir, { recursive: true, mode: 0o700 });
                const skillMdPath = NodePath.join(skillDir, "SKILL.md");
                assertPathContainedWithin(skillDir, skillMdPath);
                await NodeFSP.writeFile(skillMdPath, skill.skillMd, "utf8");
                for (const ref of skill.references) {
                  const refPath = NodePath.join(skillDir, ...ref.path.split("/"));
                  assertPathContainedWithin(skillDir, refPath);
                  await NodeFSP.mkdir(NodePath.dirname(refPath), { recursive: true, mode: 0o700 });
                  await NodeFSP.writeFile(refPath, ref.content, "utf8");
                }
              }

              if (spec.personalSkillLayout.kind === "directory-symlinks") {
                await syncDirectoryPersonalSkillLinks({
                  targetSkillsDir: stagingSkillsDir,
                  personalSkillsDir: NodePath.join(
                    userHome,
                    ...spec.personalSkillLayout.personalRelativeDir,
                  ),
                  teamSlugsLower,
                  platform,
                });
              }

              const hadExisting = await NodeFSP.lstat(paths.skillsDir)
                .then(() => true)
                .catch(() => false);
              if (hadExisting) {
                await NodeFSP.rename(paths.skillsDir, backupSkillsDir);
              }
              try {
                await NodeFSP.rename(stagingSkillsDir, paths.skillsDir);
              } catch (swapError) {
                if (hadExisting) {
                  await NodeFSP.rename(backupSkillsDir, paths.skillsDir).catch(() => undefined);
                }
                throw swapError;
              }
              if (hadExisting) {
                await NodeFSP.rm(backupSkillsDir, { recursive: true, force: true }).catch(
                  () => undefined,
                );
              }
            } catch (stageError) {
              await NodeFSP.rm(stagingSkillsDir, { recursive: true, force: true }).catch(
                () => undefined,
              );
              throw stageError;
            }

            if (spec.personalSkillLayout.kind === "antigravity-config-and-plugins") {
              await syncAntigravityPersonalConfigAndPlugins({
                profileDir: paths.profileDir,
                skillsDir: paths.skillsDir,
                userHome,
                layout: spec.personalSkillLayout,
                platform,
              });
            }
          },
          catch: (cause) => new TeamProfileMaterializerIoError({ cause }),
        }).pipe(
          Effect.catch((cause) => {
            skillsMaterialized = false;
            return Effect.logWarning("TeamProfileMaterializer.materializeAssets failed", {
              virtualInstanceId: input.virtualInstanceId,
              driver: input.driver,
              cause,
            });
          }),
        );

        let instructionsMaterialized = true;
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
              Effect.catch((cause) => {
                instructionsMaterialized = false;
                return Effect.logWarning("TeamProfileMaterializer.writeInstructionFile failed", {
                  instructionPath,
                  cause,
                });
              }),
            );
          } else {
            yield* fs.remove(instructionPath, { force: true }).pipe(
              Effect.catch((cause) => {
                instructionsMaterialized = false;
                return Effect.logWarning("TeamProfileMaterializer.removeInstructionFile failed", {
                  instructionPath,
                  cause,
                });
              }),
            );
          }
        }

        // Only persist the assetsHash marker when both skills and instructions succeeded so
        // transient disk errors are automatically repaired on the next materialization pass.
        if (skillsMaterialized && instructionsMaterialized) {
          yield* Effect.tryPromise({
            try: () =>
              NodeFSP.writeFile(
                NodePath.join(paths.profileDir, TEAM_PROFILE_MARKER_FILENAME),
                `${encodeJsonUnknown({
                  teamId: input.teamId,
                  virtualInstanceId: input.virtualInstanceId,
                  driver: input.driver,
                  revision: input.revision,
                  assetsHash,
                })}\n`,
                "utf8",
              ),
            catch: () => undefined,
          }).pipe(Effect.ignore);
        }

        return paths;
      }),
    );
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
  const spec = getTeamHarnessProfile(input.driver);
  if (spec.ephemeralTokenFormat === "in-memory" || spec.ephemeralTokenFormat === "none") {
    return;
  }
  const primarySegments = spec.ephemeralTokenRelativePaths[0];
  if (primarySegments === undefined) return;
  const platform = yield* HostProcess.Platform;
  const paths = yield* resolveTeamProfilePaths({
    stateDir: input.stateDir,
    teamId: input.teamId,
    virtualInstanceId: input.virtualInstanceId,
    driver: input.driver,
  });
  const tokenPath = NodePath.join(paths.profileDir, ...primarySegments);

  if (spec.ephemeralTokenFormat === "antigravity-oauth-json") {
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

  if (spec.ephemeralTokenFormat === "claude-credentials-json") {
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
      try: () => writeSecureTokenFile(tokenPath, `${encodeJsonUnknown(payload)}\n`, platform),
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
