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
  purgeTeamProfileDirectory,
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
          const tokenPath = NodePath.join(paths.profileDir, TEAM_ANTIGRAVITY_OAUTH_TOKEN_FILENAME);
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
});
