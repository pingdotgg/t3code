// @effect-diagnostics nodeBuiltinImport:off -- Test asserts exact permissions and filesystem isolation on disk.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  IsoDateTime,
  NonNegativeInt,
  ProviderDriverKind,
  ProviderInstanceId,
  TeamId,
  TeamMemberId,
  TeamPrepromptId,
  TeamSkillId,
  TeamSkillSlug,
  makeTeamProviderInstanceId,
  type TeamPreprompt,
  type TeamSkill,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect, it } from "@effect/vitest";

import { discoverAntigravitySkills } from "../provider/Drivers/AntigravitySkills.ts";
import {
  TEAM_ANTIGRAVITY_OAUTH_TOKEN_FILENAME,
  materializeEphemeralLeaseToken,
  materializeTeamProfileAssets,
  purgeEphemeralLeaseTokens,
  purgePinnedRelativeTokenFile,
  purgeTeamProfileDirectory,
  writePinnedRelativeTokenFile,
} from "./TeamProfileMaterializer.ts";

const platformLayer = Layer.mergeAll(NodeServices.layer, NodeCrypto.layer);

const makeSkill = (
  slug: string,
  description: string,
  driver: "*" | ProviderDriverKind = "*",
): TeamSkill => ({
  id: TeamSkillId.make(`skill-${slug}`),
  teamId: TeamId.make("team-alpha"),
  slug: TeamSkillSlug.make(slug),
  providerDriver: driver,
  skillMd: `---\nname: ${slug}\ndescription: ${description}\n---\n\n# ${slug}\nTeam body\n`,
  references: [{ path: "references/guide.md", content: "# Guide\n" }],
  enabled: true,
  revision: NonNegativeInt.make(1),
  contentHash: "a".repeat(64),
  updatedByMemberId: TeamMemberId.make("member-alice"),
  createdAt: IsoDateTime.make("2026-01-01T00:00:00.000Z"),
  updatedAt: IsoDateTime.make("2026-01-01T00:00:00.000Z"),
});

const makePreprompt = (
  name: string,
  content: string,
  injectionScope: "thread" | "turn" = "thread",
  driver: "*" | ProviderDriverKind = "*",
): TeamPreprompt => ({
  id: TeamPrepromptId.make(`pp-${name}`),
  teamId: TeamId.make("team-alpha"),
  name,
  providerDriver: driver,
  injectionScope,
  content,
  enabled: true,
  revision: NonNegativeInt.make(1),
  contentHash: "b".repeat(64),
  updatedByMemberId: TeamMemberId.make("member-alice"),
  createdAt: IsoDateTime.make("2026-01-01T00:00:00.000Z"),
  updatedAt: IsoDateTime.make("2026-01-01T00:00:00.000Z"),
});

describe("TeamProfileMaterializer", () => {
  it.effect(
    "materializes isolated Antigravity profile preserving personal skills with team precedence and never modifying ~/.gemini",
    () =>
      Effect.gen(function* () {
        const tmp = yield* Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-team-mat-")),
        );
        try {
          const stateDir = NodePath.join(tmp, "state");
          const fakeHome = NodePath.join(tmp, "home");
          const workspaceDir = NodePath.join(tmp, "repo");
          const personalSkillsRoot = NodePath.join(fakeHome, ".gemini", "config", "skills");
          const personalGeminiMd = NodePath.join(fakeHome, ".gemini", "GEMINI.md");
          yield* Effect.promise(async () => {
            await NodeFSP.mkdir(NodePath.join(personalSkillsRoot, "personal-only"), {
              recursive: true,
            });
            await NodeFSP.writeFile(
              NodePath.join(personalSkillsRoot, "personal-only", "SKILL.md"),
              "---\nname: personal-only\ndescription: Personal skill\n---\nPersonal body",
            );
            await NodeFSP.mkdir(NodePath.join(personalSkillsRoot, "shared-slug"), {
              recursive: true,
            });
            await NodeFSP.writeFile(
              NodePath.join(personalSkillsRoot, "shared-slug", "SKILL.md"),
              "---\nname: shared-slug\ndescription: Personal version\n---\nPersonal body",
            );
            await NodeFSP.writeFile(personalGeminiMd, "# Personal rules untouched\n");
            await NodeFSP.mkdir(workspaceDir, { recursive: true });
          });

          const teamId = TeamId.make("team-alpha");
          const virtualId = makeTeamProviderInstanceId(teamId, ProviderInstanceId.make("team-agy"));
          const paths = yield* materializeTeamProfileAssets({
            stateDir,
            teamId,
            virtualInstanceId: virtualId,
            driver: ProviderDriverKind.make("antigravity"),
            skills: [
              makeSkill("shared-slug", "Team authoritative version"),
              makeSkill("team-only", "Team only skill"),
            ],
            preprompts: [
              makePreprompt("Team Thread Rule", "Always write Effect services.", "thread"),
              makePreprompt("Team Turn Rule", "Never leak secrets.", "turn"),
            ],
            revision: 3,
            userHome: fakeHome,
          });

          // Personal ~/.gemini/GEMINI.md must be 100% untouched.
          const personalContent = yield* Effect.promise(() =>
            NodeFSP.readFile(personalGeminiMd, "utf8"),
          );
          expect(personalContent).toBe("# Personal rules untouched\n");

          // Isolated profile GEMINI.md contains ONLY thread-scoped pre-prompts, not turn-scoped ones.
          const teamGeminiMd = yield* Effect.promise(() =>
            NodeFSP.readFile(paths.instructionFile!, "utf8"),
          );
          expect(teamGeminiMd).toContain("Always write Effect services.");
          expect(teamGeminiMd).not.toContain("Never leak secrets.");

          // Skill discovery sees personal-only + team-only + team version of shared-slug!
          const discovered = yield* discoverAntigravitySkills({
            cwd: workspaceDir,
            userHome: fakeHome,
            profileDirectory: paths.profileDir,
          });
          const byName = new Map(discovered.map((s) => [s.name, s]));
          expect(byName.get("personal-only")?.description).toBe("Personal skill");
          expect(byName.get("team-only")?.description).toBe("Team only skill");
          expect(byName.get("shared-slug")?.description).toBe("Team authoritative version");
          expect(byName.get("shared-slug")?.scope).toBe("team");

          // Ephemeral OAuth lease writes chmod 0600 file with ZERO refresh_token, then purges cleanly.
          yield* materializeEphemeralLeaseToken({
            stateDir,
            teamId,
            virtualInstanceId: virtualId,
            driver: ProviderDriverKind.make("antigravity"),
            lease: {
              providerInstanceId: ProviderInstanceId.make("team-agy"),
              driver: ProviderDriverKind.make("antigravity"),
              accessToken: "ya29.ephemeral-team-token",
              tokenType: "Bearer",
              expiresAt: IsoDateTime.make("2099-01-01T00:00:00.000Z"),
              expiresInSeconds: NonNegativeInt.make(3600),
              email: "team@example.com",
            },
          });
          const tokenPath = NodePath.join(
            paths.profileDir,
            "antigravity-acp",
            TEAM_ANTIGRAVITY_OAUTH_TOKEN_FILENAME,
          );
          const tokenRaw = yield* Effect.promise(() => NodeFSP.readFile(tokenPath, "utf8"));
          expect(tokenRaw).toContain("ya29.ephemeral-team-token");
          expect(tokenRaw).not.toContain("refresh_token");
          if ((yield* HostProcess.Platform) !== "win32") {
            const stat = yield* Effect.promise(() => NodeFSP.stat(tokenPath));
            expect(stat.mode & 0o777).toBe(0o600);
          }

          yield* purgeEphemeralLeaseTokens({
            stateDir,
            teamId,
            virtualInstanceId: virtualId,
            driver: ProviderDriverKind.make("antigravity"),
          });
          const existsAfterPurge = yield* Effect.promise(() =>
            NodeFSP.access(tokenPath)
              .then(() => true)
              .catch(() => false),
          );
          expect(existsAfterPurge).toBe(false);

          yield* purgeTeamProfileDirectory({
            stateDir,
            teamId,
            virtualInstanceId: virtualId,
            driver: ProviderDriverKind.make("antigravity"),
          });
          const dirExistsAfterPurge = yield* Effect.promise(() =>
            NodeFSP.access(paths.profileDir)
              .then(() => true)
              .catch(() => false),
          );
          expect(dirExistsAfterPurge).toBe(false);
        } finally {
          yield* Effect.promise(() => NodeFSP.rm(tmp, { recursive: true, force: true }));
        }
      }).pipe(Effect.provide(platformLayer)),
  );

  it.effect(
    "materializes Codex profile with AGENTS.md, team precedence over ~/.codex/skills, and ZERO token file on disk",
    () =>
      Effect.gen(function* () {
        const tmp = yield* Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-team-codex-")),
        );
        try {
          const stateDir = NodePath.join(tmp, "state");
          const fakeHome = NodePath.join(tmp, "home");
          const personalCodexSkills = NodePath.join(fakeHome, ".codex", "skills");
          yield* Effect.promise(async () => {
            await NodeFSP.mkdir(NodePath.join(personalCodexSkills, "my-personal"), {
              recursive: true,
            });
            await NodeFSP.writeFile(
              NodePath.join(personalCodexSkills, "my-personal", "SKILL.md"),
              "---\nname: my-personal\ndescription: Personal\n---\n",
            );
            await NodeFSP.mkdir(NodePath.join(personalCodexSkills, "deploy"), { recursive: true });
            await NodeFSP.writeFile(
              NodePath.join(personalCodexSkills, "deploy", "SKILL.md"),
              "---\nname: deploy\ndescription: Personal deploy\n---\n",
            );
          });

          const teamId = TeamId.make("team-alpha");
          const virtualId = makeTeamProviderInstanceId(
            teamId,
            ProviderInstanceId.make("team-codex"),
          );
          const paths = yield* materializeTeamProfileAssets({
            stateDir,
            teamId,
            virtualInstanceId: virtualId,
            driver: ProviderDriverKind.make("codex"),
            skills: [makeSkill("deploy", "Team deploy")],
            preprompts: [makePreprompt("Codex Guide", "Use Effect v4.", "thread")],
            revision: 1,
            userHome: fakeHome,
          });

          const agentsMd = yield* Effect.promise(() =>
            NodeFSP.readFile(NodePath.join(paths.profileDir, "AGENTS.md"), "utf8"),
          );
          expect(agentsMd).toContain("Use Effect v4.");

          const deployMd = yield* Effect.promise(() =>
            NodeFSP.readFile(NodePath.join(paths.skillsDir, "deploy", "SKILL.md"), "utf8"),
          );
          expect(deployMd).toContain("Team deploy");

          const personalLink = yield* Effect.promise(() =>
            NodeFSP.readFile(NodePath.join(paths.skillsDir, "my-personal", "SKILL.md"), "utf8"),
          );
          expect(personalLink).toContain("Personal");

          // Codex ephemeral token materialization MUST write zero token files to disk!
          yield* materializeEphemeralLeaseToken({
            stateDir,
            teamId,
            virtualInstanceId: virtualId,
            driver: ProviderDriverKind.make("codex"),
            lease: {
              providerInstanceId: ProviderInstanceId.make("team-codex"),
              driver: ProviderDriverKind.make("codex"),
              accessToken: "codex-memory-only-token",
              tokenType: "Bearer",
              expiresAt: IsoDateTime.make("2099-01-01T00:00:00.000Z"),
              expiresInSeconds: NonNegativeInt.make(3600),
            },
          });
          const entries = yield* Effect.promise(() => NodeFSP.readdir(paths.profileDir));
          expect(entries.some((name) => name.includes("token") || name.includes("auth"))).toBe(
            false,
          );
        } finally {
          yield* Effect.promise(() => NodeFSP.rm(tmp, { recursive: true, force: true }));
        }
      }).pipe(Effect.provide(platformLayer)),
  );

  it.effect(
    "rejects malicious traversal slugs and executable skill references before writing anything to disk",
    () =>
      Effect.gen(function* () {
        const tmp = yield* Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-team-traversal-")),
        );
        try {
          const stateDir = NodePath.join(tmp, "state");
          const fakeHome = NodePath.join(tmp, "home");
          const teamId = TeamId.make("team-alpha");
          const virtualId = makeTeamProviderInstanceId(
            teamId,
            ProviderInstanceId.make("team-codex"),
          );
          const evilTraversalSkill: TeamSkill = {
            ...makeSkill("safe-name", "Safe"),
            slug: "../../escaped" as TeamSkillSlug,
          };
          const executableRefSkill: TeamSkill = {
            ...makeSkill("exec-skill", "Executable"),
            references: [{ path: "scripts/pwn.sh", content: "#!/bin/sh\necho pwn\n" }],
          };
          const paths = yield* materializeTeamProfileAssets({
            stateDir,
            teamId,
            virtualInstanceId: virtualId,
            driver: ProviderDriverKind.make("codex"),
            skills: [evilTraversalSkill, executableRefSkill, makeSkill("valid-skill", "Valid")],
            preprompts: [],
            revision: 1,
            userHome: fakeHome,
          });

          const escapedExists = yield* Effect.promise(() =>
            NodeFSP.access(NodePath.resolve(paths.skillsDir, "../../escaped"))
              .then(() => true)
              .catch(() => false),
          );
          expect(escapedExists).toBe(false);

          const execSkillExists = yield* Effect.promise(() =>
            NodeFSP.access(NodePath.join(paths.skillsDir, "exec-skill"))
              .then(() => true)
              .catch(() => false),
          );
          expect(execSkillExists).toBe(false);

          const validSkillMd = yield* Effect.promise(() =>
            NodeFSP.readFile(NodePath.join(paths.skillsDir, "valid-skill", "SKILL.md"), "utf8"),
          );
          expect(validSkillMd).toContain("Valid");
        } finally {
          yield* Effect.promise(() => NodeFSP.rm(tmp, { recursive: true, force: true }));
        }
      }).pipe(Effect.provide(platformLayer)),
  );

  it.effect(
    "preserves enabled personal Antigravity plugins (skills/ and plugin.json skills), hides disabled plugins, keeps team skill precedence, and refreshes links when assetsHash is unchanged",
    () =>
      Effect.gen(function* () {
        const tmp = yield* Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-team-agy-plugins-")),
        );
        try {
          const stateDir = NodePath.join(tmp, "state");
          const fakeHome = NodePath.join(tmp, "home");
          const workspaceDir = NodePath.join(tmp, "repo");
          const personalConfigDir = NodePath.join(fakeHome, ".gemini", "config");
          const personalPluginsDir = NodePath.join(personalConfigDir, "plugins");
          const personalConfigJson = NodePath.join(personalConfigDir, "config.json");
          const initialConfigJson = `${JSON.stringify(
            {
              plugins: {
                "disabled-plugin": { enabled: false },
                "enabled-plugin": { enabled: true },
              },
            },
            null,
            2,
          )}\n`;

          yield* Effect.promise(async () => {
            await NodeFSP.mkdir(workspaceDir, { recursive: true });
            await NodeFSP.mkdir(personalPluginsDir, { recursive: true });
            await NodeFSP.writeFile(personalConfigJson, initialConfigJson, "utf8");

            // Enabled plugin with both default `skills/` and manifest `skills` custom path, plus a colliding skill name.
            const enabledPluginDir = NodePath.join(personalPluginsDir, "enabled-plugin");
            await NodeFSP.mkdir(NodePath.join(enabledPluginDir, "skills", "plugin-default-skill"), {
              recursive: true,
            });
            await NodeFSP.mkdir(NodePath.join(enabledPluginDir, "skills", "colliding-skill"), {
              recursive: true,
            });
            await NodeFSP.mkdir(NodePath.join(enabledPluginDir, "extra-skills", "manifest-skill"), {
              recursive: true,
            });
            await NodeFSP.writeFile(
              NodePath.join(enabledPluginDir, "plugin.json"),
              JSON.stringify({ name: "enabled-plugin", skills: ["extra-skills/manifest-skill"] }),
              "utf8",
            );
            await NodeFSP.writeFile(
              NodePath.join(enabledPluginDir, "skills", "plugin-default-skill", "SKILL.md"),
              "---\nname: plugin-default-skill\ndescription: From plugin skills/\n---\nBody\n",
              "utf8",
            );
            await NodeFSP.writeFile(
              NodePath.join(enabledPluginDir, "skills", "colliding-skill", "SKILL.md"),
              "---\nname: colliding-skill\ndescription: Personal plugin version\n---\nBody\n",
              "utf8",
            );
            await NodeFSP.writeFile(
              NodePath.join(enabledPluginDir, "extra-skills", "manifest-skill", "SKILL.md"),
              "---\nname: manifest-skill\ndescription: From plugin.json skills\n---\nBody\n",
              "utf8",
            );

            // Disabled plugin must remain hidden in the isolated team profile.
            const disabledPluginDir = NodePath.join(personalPluginsDir, "disabled-plugin");
            await NodeFSP.mkdir(NodePath.join(disabledPluginDir, "skills", "hidden-skill"), {
              recursive: true,
            });
            await NodeFSP.writeFile(
              NodePath.join(disabledPluginDir, "plugin.json"),
              JSON.stringify({ name: "disabled-plugin" }),
              "utf8",
            );
            await NodeFSP.writeFile(
              NodePath.join(disabledPluginDir, "skills", "hidden-skill", "SKILL.md"),
              "---\nname: hidden-skill\ndescription: Should stay hidden\n---\nBody\n",
              "utf8",
            );
          });

          const teamId = TeamId.make("team-alpha");
          const virtualId = makeTeamProviderInstanceId(teamId, ProviderInstanceId.make("team-agy"));
          const teamSkills = [makeSkill("colliding-skill", "Team authoritative skill")];

          const paths = yield* materializeTeamProfileAssets({
            stateDir,
            teamId,
            virtualInstanceId: virtualId,
            driver: ProviderDriverKind.make("antigravity"),
            skills: teamSkills,
            preprompts: [],
            revision: 1,
            userHome: fakeHome,
          });

          const discovered1 = yield* discoverAntigravitySkills({
            cwd: workspaceDir,
            userHome: fakeHome,
            profileDirectory: paths.profileDir,
          });
          const byName1 = new Map(discovered1.map((s) => [s.name, s]));
          expect(byName1.get("plugin-default-skill")?.description).toBe("From plugin skills/");
          expect(byName1.get("plugin-default-skill")?.displayName).toBe(
            "enabled-plugin:plugin-default-skill",
          );
          expect(byName1.get("manifest-skill")?.description).toBe("From plugin.json skills");
          expect(byName1.get("manifest-skill")?.displayName).toBe("enabled-plugin:manifest-skill");
          expect(byName1.has("hidden-skill")).toBe(false);
          // Team skill MUST win on slug/name collision over personal plugin skill!
          expect(byName1.get("colliding-skill")?.description).toBe("Team authoritative skill");
          expect(byName1.get("colliding-skill")?.scope).toBe("team");

          // Personal ~/.gemini/config/config.json was never modified.
          expect(yield* Effect.promise(() => NodeFSP.readFile(personalConfigJson, "utf8"))).toBe(
            initialConfigJson,
          );

          // Now add a new personal plugin AND disable `enabled-plugin` WITHOUT bumping team assetsHash/revision!
          yield* Effect.promise(async () => {
            const addedPluginDir = NodePath.join(personalPluginsDir, "added-later");
            await NodeFSP.mkdir(NodePath.join(addedPluginDir, "skills", "fresh-plugin-skill"), {
              recursive: true,
            });
            await NodeFSP.writeFile(
              NodePath.join(addedPluginDir, "plugin.json"),
              JSON.stringify({ name: "added-later" }),
              "utf8",
            );
            await NodeFSP.writeFile(
              NodePath.join(addedPluginDir, "skills", "fresh-plugin-skill", "SKILL.md"),
              "---\nname: fresh-plugin-skill\ndescription: Added while team hash unchanged\n---\nBody\n",
              "utf8",
            );
            await NodeFSP.writeFile(
              personalConfigJson,
              `${JSON.stringify(
                {
                  plugins: {
                    "disabled-plugin": { enabled: false },
                    "enabled-plugin": { enabled: false },
                  },
                },
                null,
                2,
              )}\n`,
              "utf8",
            );
          });

          // Re-materialize with identical team skills/preprompts/revision (same assetsHash):
          yield* materializeTeamProfileAssets({
            stateDir,
            teamId,
            virtualInstanceId: virtualId,
            driver: ProviderDriverKind.make("antigravity"),
            skills: teamSkills,
            preprompts: [],
            revision: 1,
            userHome: fakeHome,
          });

          const discovered2 = yield* discoverAntigravitySkills({
            cwd: workspaceDir,
            userHome: fakeHome,
            profileDirectory: paths.profileDir,
          });
          const byName2 = new Map(discovered2.map((s) => [s.name, s]));
          expect(byName2.get("fresh-plugin-skill")?.description).toBe(
            "Added while team hash unchanged",
          );
          expect(byName2.has("plugin-default-skill")).toBe(false);
          expect(byName2.has("manifest-skill")).toBe(false);
          expect(byName2.get("colliding-skill")?.scope).toBe("team");
        } finally {
          yield* Effect.promise(() => NodeFSP.rm(tmp, { recursive: true, force: true }));
        }
      }).pipe(Effect.provide(platformLayer)),
  );

  it.effect(
    "replaces a symlinked config parent without writing outside the profile on unchanged assetsHash and clears non-symlink plugin shadows",
    () =>
      Effect.gen(function* () {
        const tmp = yield* Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-team-parent-symlink-")),
        );
        try {
          const stateDir = NodePath.join(tmp, "state");
          const fakeHome = NodePath.join(tmp, "home");
          const externalHostDir = NodePath.join(tmp, "outside-host-dir");
          const personalPluginDir = NodePath.join(
            fakeHome,
            ".gemini",
            "config",
            "plugins",
            "real-plugin",
          );
          yield* Effect.promise(async () => {
            await NodeFSP.mkdir(externalHostDir, { recursive: true });
            await NodeFSP.mkdir(NodePath.join(personalPluginDir, "skills", "real-skill"), {
              recursive: true,
            });
            await NodeFSP.writeFile(
              NodePath.join(personalPluginDir, "plugin.json"),
              JSON.stringify({ name: "real-plugin" }),
              "utf8",
            );
            await NodeFSP.writeFile(
              NodePath.join(personalPluginDir, "skills", "real-skill", "SKILL.md"),
              "---\nname: real-skill\ndescription: Real plugin skill\n---\nBody\n",
              "utf8",
            );
          });

          const teamId = TeamId.make("team-alpha");
          const virtualId = makeTeamProviderInstanceId(teamId, ProviderInstanceId.make("team-agy"));
          const paths = yield* materializeTeamProfileAssets({
            stateDir,
            teamId,
            virtualInstanceId: virtualId,
            driver: ProviderDriverKind.make("antigravity"),
            skills: [],
            preprompts: [],
            revision: 1,
            userHome: fakeHome,
          });

          // Simulate a compromised turn replacing `<teamProfile>/config` with a symlink to an external host directory.
          const configDir = NodePath.join(paths.profileDir, "config");
          yield* Effect.promise(async () => {
            await NodeFSP.rm(configDir, { recursive: true, force: true });
            await NodeFSP.symlink(externalHostDir, configDir, "dir");
          });

          // Re-materialize with identical team assets (unchanged assetsHash fast path):
          yield* materializeTeamProfileAssets({
            stateDir,
            teamId,
            virtualInstanceId: virtualId,
            driver: ProviderDriverKind.make("antigravity"),
            skills: [],
            preprompts: [],
            revision: 1,
            userHome: fakeHome,
          });

          // External host directory must remain completely untouched, and `config` must be a real directory again.
          const outsideEntries = yield* Effect.promise(() => NodeFSP.readdir(externalHostDir));
          expect(outsideEntries).toEqual([]);
          const configStat = yield* Effect.promise(() => NodeFSP.lstat(configDir));
          expect(configStat.isSymbolicLink()).toBe(false);
          expect(configStat.isDirectory()).toBe(true);

          // Plant a non-symlink directory shadowing `real-plugin` inside `config/plugins`, then re-sync:
          const shadowedPath = NodePath.join(configDir, "plugins", "real-plugin");
          yield* Effect.promise(async () => {
            await NodeFSP.unlink(shadowedPath);
            await NodeFSP.mkdir(shadowedPath, { recursive: true });
            await NodeFSP.writeFile(NodePath.join(shadowedPath, "decoy.txt"), "shadow", "utf8");
          });
          yield* materializeTeamProfileAssets({
            stateDir,
            teamId,
            virtualInstanceId: virtualId,
            driver: ProviderDriverKind.make("antigravity"),
            skills: [],
            preprompts: [],
            revision: 1,
            userHome: fakeHome,
          });
          const restoredStat = yield* Effect.promise(() => NodeFSP.lstat(shadowedPath));
          expect(restoredStat.isSymbolicLink()).toBe(true);

          // Tampered marker driver with identical assetsHash must be detected and restored (never skipped).
          const markerPath = NodePath.join(paths.profileDir, ".t3-team-profile.json");
          const originalMarker = JSON.parse(
            yield* Effect.promise(() => NodeFSP.readFile(markerPath, "utf8")),
          ) as { readonly driver: string; readonly assetsHash: string };
          yield* Effect.promise(() =>
            NodeFSP.writeFile(
              markerPath,
              `${JSON.stringify({ ...originalMarker, driver: "other" })}\n`,
              "utf8",
            ),
          );
          yield* materializeTeamProfileAssets({
            stateDir,
            teamId,
            virtualInstanceId: virtualId,
            driver: ProviderDriverKind.make("antigravity"),
            skills: [],
            preprompts: [],
            revision: 1,
            userHome: fakeHome,
          });
          const restoredMarker = JSON.parse(
            yield* Effect.promise(() => NodeFSP.readFile(markerPath, "utf8")),
          ) as { readonly driver: string };
          expect(restoredMarker.driver).toBe("antigravity");

          // Symlinked marker file must NOT overwrite the external target file.
          const externalSecretFile = NodePath.join(externalHostDir, "untouched.txt");
          yield* Effect.promise(async () => {
            await NodeFSP.writeFile(externalSecretFile, "KEEP_ME", "utf8");
            await NodeFSP.unlink(markerPath);
            await NodeFSP.symlink(externalSecretFile, markerPath, "file");
          });
          yield* materializeTeamProfileAssets({
            stateDir,
            teamId,
            virtualInstanceId: virtualId,
            driver: ProviderDriverKind.make("antigravity"),
            skills: [],
            preprompts: [],
            revision: 1,
            userHome: fakeHome,
          });
          expect(yield* Effect.promise(() => NodeFSP.readFile(externalSecretFile, "utf8"))).toBe(
            "KEEP_ME",
          );
          const markerPostStat = yield* Effect.promise(() => NodeFSP.lstat(markerPath));
          expect(markerPostStat.isSymbolicLink()).toBe(false);

          // Symlinked `antigravity-acp` parent dir must NOT redirect ephemeral lease token writes outside profile.
          const acpDir = NodePath.join(paths.profileDir, "antigravity-acp");
          yield* Effect.promise(async () => {
            await NodeFSP.rm(acpDir, { recursive: true, force: true });
            await NodeFSP.symlink(externalHostDir, acpDir, "dir");
          });
          yield* materializeEphemeralLeaseToken({
            stateDir,
            teamId,
            virtualInstanceId: virtualId,
            driver: ProviderDriverKind.make("antigravity"),
            lease: {
              providerInstanceId: ProviderInstanceId.make("team-agy"),
              driver: ProviderDriverKind.make("antigravity"),
              accessToken: "ya29.contained-token",
              tokenType: "Bearer",
              expiresAt: IsoDateTime.make("2099-01-01T00:00:00.000Z"),
              expiresInSeconds: NonNegativeInt.make(3600),
            },
          });
          const acpStat = yield* Effect.promise(() => NodeFSP.lstat(acpDir));
          expect(acpStat.isSymbolicLink()).toBe(false);
          expect(
            yield* Effect.promise(() =>
              NodeFSP.access(NodePath.join(externalHostDir, TEAM_ANTIGRAVITY_OAUTH_TOKEN_FILENAME))
                .then(() => true)
                .catch(() => false),
            ),
          ).toBe(false);

          // Concurrent parent-swap race regression: swapping `antigravity-acp` to a symlink AFTER
          // parent pinning MUST NOT redirect either lease-token write or purge to `externalHostDir`.
          const hostPlatform = yield* HostProcess.Platform;
          if (hostPlatform === "linux") {
            const personalSentinel = NodePath.join(
              externalHostDir,
              TEAM_ANTIGRAVITY_OAUTH_TOKEN_FILENAME,
            );
            const movedAcpDir = NodePath.join(paths.profileDir, "antigravity-acp.moved-write");
            yield* Effect.promise(async () => {
              await NodeFSP.writeFile(personalSentinel, "PERSONAL-SECRET", "utf8");
              await NodeFSP.rm(movedAcpDir, { recursive: true, force: true });
            });
            yield* Effect.promise(() =>
              writePinnedRelativeTokenFile({
                rootDir: paths.profileDir,
                relativeSegments: ["antigravity-acp", TEAM_ANTIGRAVITY_OAUTH_TOKEN_FILENAME],
                contents: '{"token":"team-race-safe"}\n',
                platform: hostPlatform,
                beforeLeafOp: async () => {
                  await NodeFSP.rename(acpDir, movedAcpDir);
                  await NodeFSP.symlink(externalHostDir, acpDir, "dir");
                },
              }),
            );
            expect(yield* Effect.promise(() => NodeFSP.readFile(personalSentinel, "utf8"))).toBe(
              "PERSONAL-SECRET",
            );
            expect(
              yield* Effect.promise(() =>
                NodeFSP.readFile(
                  NodePath.join(movedAcpDir, TEAM_ANTIGRAVITY_OAUTH_TOKEN_FILENAME),
                  "utf8",
                ),
              ),
            ).toBe('{"token":"team-race-safe"}\n');

            // Restore real `antigravity-acp` containing the team token, then race-swap during purge.
            const movedPurgeDir = NodePath.join(paths.profileDir, "antigravity-acp.moved-purge");
            yield* Effect.promise(async () => {
              await NodeFSP.unlink(acpDir);
              await NodeFSP.rename(movedAcpDir, acpDir);
              await NodeFSP.rm(movedPurgeDir, { recursive: true, force: true });
            });
            yield* Effect.promise(() =>
              purgePinnedRelativeTokenFile({
                rootDir: paths.profileDir,
                relativeSegments: ["antigravity-acp", TEAM_ANTIGRAVITY_OAUTH_TOKEN_FILENAME],
                platform: hostPlatform,
                beforeLeafOp: async () => {
                  await NodeFSP.rename(acpDir, movedPurgeDir);
                  await NodeFSP.symlink(externalHostDir, acpDir, "dir");
                },
              }),
            );
            expect(yield* Effect.promise(() => NodeFSP.readFile(personalSentinel, "utf8"))).toBe(
              "PERSONAL-SECRET",
            );
            expect(
              yield* Effect.promise(() =>
                NodeFSP.access(NodePath.join(movedPurgeDir, TEAM_ANTIGRAVITY_OAUTH_TOKEN_FILENAME))
                  .then(() => true)
                  .catch(() => false),
              ),
            ).toBe(false);
          }
        } finally {
          yield* Effect.promise(() => NodeFSP.rm(tmp, { recursive: true, force: true }));
        }
      }).pipe(Effect.provide(platformLayer)),
  );
});
