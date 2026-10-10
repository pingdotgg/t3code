import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, describe, expect } from "@effect/vitest";
import {
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  SkillGetResult,
  SkillListResult,
  SkillRequestError,
  type Project,
  type SkillAgentAccess,
  type SkillSummary,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ProjectService from "../project/ProjectService.ts";
import { ProjectOperationError } from "../project/ProjectService.ts";
import * as Settings from "../serverSettings.ts";
import * as SkillCatalog from "./SkillCatalog.ts";

const encodeList = Schema.encodeUnknownEffect(SkillListResult);
const encodeGet = Schema.encodeUnknownEffect(SkillGetResult);

const skillFile = (name: string, description: string) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`;

/** A temp home and project laid out like a real machine: a synced library linked into two folders. */
const makeMachine = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-skill-catalog-" });
  const home = yield* fs.realPath(root);
  const project = path.join(home, "repos/app");
  const write = (relative: string, contents: string, executable = false) =>
    Effect.gen(function* () {
      const target = path.join(home, relative);
      yield* fs.makeDirectory(path.dirname(target), { recursive: true });
      yield* fs.writeFileString(target, contents);
      if (executable) yield* fs.chmod(target, 0o755);
    });
  const link = (target: string, from: string) =>
    Effect.gen(function* () {
      yield* fs.makeDirectory(path.dirname(path.join(home, from)), { recursive: true });
      yield* fs.symlink(path.join(home, target), path.join(home, from));
    });

  // Global: a synced library linked into the standard folder, and into Claude's folder for one.
  for (const name of ["architect", "grill"])
    yield* write(`Knowledge/skills/${name}/SKILL.md`, skillFile(name, `The ${name} skill.`));
  yield* write("Knowledge/skills/tdd/SKILL.md", skillFile("tdd", "Global test-first loop."));
  yield* write("Knowledge/skills/shared/SKILL.md", skillFile("shared", "Same everywhere."));
  yield* write("Knowledge/skills/architect/refs/principles.md", "# principles\n");
  for (const name of ["architect", "grill", "tdd", "shared"])
    yield* link(`Knowledge/skills/${name}`, `.agents/skills/${name}`);
  yield* link("Knowledge/skills/architect", ".claude/skills/architect");
  yield* link("missing/skills/gone", ".agents/skills/broken");
  yield* write(
    ".claude/skills/cloudflare/SKILL.md",
    skillFile("cloudflare", "Deploy to Cloudflare."),
  );
  yield* write(".claude/skills/not-a-skill/notes.txt", "no SKILL.md here");
  yield* write(".claude/skills/.hidden/SKILL.md", skillFile("hidden", "Hidden."));

  // Project: a real standard folder, a skill that only Claude reads, and a copy of a global name.
  yield* write(
    "repos/app/.agents/skills/verify/SKILL.md",
    "---\nname: verify\ndescription: >-\n  Drive the app in a browser\n  and capture evidence.\n---\n\n# verify\n",
  );
  yield* write("repos/app/.agents/skills/verify/bin/run", "#!/usr/bin/env bash\n", true);
  yield* write("repos/app/.agents/skills/verify/lib/serve.mjs", "export {};\n");
  yield* write("repos/app/.agents/skills/tdd/SKILL.md", skillFile("tdd", "Project test loop."));
  yield* write("repos/app/.agents/skills/shared/SKILL.md", skillFile("shared", "Same everywhere."));
  yield* write("repos/app/.claude/skills/own-copy/SKILL.md", skillFile("own-copy", "Claude only."));
  yield* link("repos/app/.agents/skills/verify", "repos/app/.claude/skills/verify");
  return { home, project, write, link };
});

/** Cursor, Grok, OpenCode, Antigravity and Pi are off until the user turns them on. */
const ALL_AGENTS_ENABLED = Object.fromEntries(
  ["cursor", "grok", "opencode", "antigravity", "pi"].map((driver) => [
    ProviderInstanceId.make(driver),
    { driver: ProviderDriverKind.make(driver), enabled: true },
  ]),
);

const makeProject = (workspaceRoot: string): Project => ({
  id: ProjectId.make("project-skill-catalog"),
  title: "App",
  workspaceRoot,
  repositoryIdentity: null,
  faviconPath: null,
  projectIcon: null,
  defaultModelSelection: null,
  defaultThreadEnvMode: null,
  autoPull: false,
  scripts: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  deletedAt: null,
});

/**
 * The catalog as it sees a machine whose home is `home`, with these server settings. Only the
 * `registered` folders are projects; by default that is the machine's `repos/app`.
 */
const withCatalog = <A, E, R>(
  home: string,
  use: (catalog: SkillCatalog.SkillCatalog["Service"]) => Effect.Effect<A, E, R>,
  options: {
    readonly settings?: Parameters<typeof Settings.layerTest>[0];
    readonly env?: NodeJS.ProcessEnv;
    readonly registered?: readonly string[];
  } = {},
) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const registered = options.registered ?? [path.join(home, "repos/app")];
    const projects = Layer.mock(ProjectService.ProjectService)({
      getByWorkspaceRoot: (root) =>
        Effect.succeed(registered.includes(root) ? Option.some(makeProject(root)) : Option.none()),
    });
    return yield* Effect.gen(function* () {
      return yield* use(yield* SkillCatalog.SkillCatalog);
    }).pipe(
      Effect.provide(
        SkillCatalog.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              projects,
              Settings.layerTest({
                ...options.settings,
                providerInstances: {
                  ...ALL_AGENTS_ENABLED,
                  ...options.settings?.providerInstances,
                },
              }),
            ),
          ),
        ),
      ),
    );
  }).pipe(
    Effect.provideService(HostProcess.Environment, { HOME: home, ...options.env }),
    Effect.provideService(HostProcess.HomeDirectory, home),
  );

const byKey = (skills: readonly SkillSummary[]) =>
  new Map(skills.map((skill) => [`${skill.scope}:${skill.name}`, skill]));
const accessOf = (skill: SkillSummary | undefined) =>
  Object.fromEntries(
    (skill?.access ?? []).map((entry: SkillAgentAccess) => [
      entry.instanceId,
      { state: entry.state, folder: entry.folder },
    ]),
  );
const states = (skill: SkillSummary | undefined) =>
  Object.fromEntries(Object.entries(accessOf(skill)).map(([agent, { state }]) => [agent, state]));

const NOT_FOUND = {
  home: null,
  description: "",
  contents: null,
  files: [],
  filesTruncated: false,
};

it.layer(NodeServices.layer, { excludeTestServices: true })("SkillCatalog", (it) => {
  describe("list", () => {
    it.effect.skipIf(!symlinksSupported)(
      "tells how each agent reaches a skill: shared folder, link, own folder or not at all",
      () =>
        Effect.gen(function* () {
          const { home, project } = yield* makeMachine;
          const { skills } = yield* withCatalog(home, (catalog) => catalog.list({ cwd: project }));
          const byName = byKey(skills);

          const architect = byName.get("global:architect");
          expect(architect).toMatchObject({
            home: "~/Knowledge/skills/architect",
            description: "The architect skill.",
          });
          expect(accessOf(architect)).toEqual({
            // Claude only reads its own folder, so the library skill reaches it through a link.
            claudeAgent: { state: "link", folder: "~/.claude/skills" },
            codex: { state: "direct", folder: "~/.agents/skills" },
            cursor: { state: "direct", folder: "~/.agents/skills" },
            grok: { state: "direct", folder: "~/.agents/skills" },
            opencode: { state: "direct", folder: "~/.agents/skills" },
            // Antigravity reads `.agents/skills` in a project, but not in the global level.
            antigravity: { state: "none", folder: "~/.gemini/config/skills" },
            pi: { state: "direct", folder: "~/.agents/skills" },
          });
          expect(accessOf(byName.get("global:grill")).claudeAgent).toEqual({
            state: "none",
            folder: "~/.claude/skills",
          });

          const cloudflare = byName.get("global:cloudflare");
          expect(cloudflare?.home).toBe("~/.claude/skills/cloudflare");
          expect(accessOf(cloudflare)).toMatchObject({
            claudeAgent: { state: "direct", folder: "~/.claude/skills" },
            cursor: { state: "direct", folder: "~/.claude/skills" },
            opencode: { state: "direct", folder: "~/.claude/skills" },
            codex: { state: "none", folder: "~/.agents/skills" },
          });

          const verify = byName.get("project:verify");
          expect(verify?.home).toBe(".agents/skills/verify");
          expect(accessOf(verify)).toEqual({
            claudeAgent: { state: "link", folder: ".claude/skills" },
            codex: { state: "direct", folder: ".agents/skills" },
            cursor: { state: "direct", folder: ".agents/skills" },
            grok: { state: "none", folder: ".grok/skills" },
            opencode: { state: "direct", folder: ".agents/skills" },
            antigravity: { state: "direct", folder: ".agents/skills" },
            pi: { state: "direct", folder: ".agents/skills" },
          });
          expect(accessOf(byName.get("project:own-copy"))).toMatchObject({
            claudeAgent: { state: "direct", folder: ".claude/skills" },
            codex: { state: "none", folder: ".agents/skills" },
            pi: { state: "none", folder: ".pi/skills" },
          });
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "skips folders that aren't skills and links that point nowhere",
      () =>
        Effect.gen(function* () {
          const { home, project, write } = yield* makeMachine;
          // Only SKILL.md makes a skill: a lowercase file, a folder named SKILL.md and a
          // dot-folder don't.
          yield* write(".agents/skills/lowercase/skill.md", skillFile("lowercase", "Lower."));
          yield* write(".agents/skills/odd/SKILL.md/inner.txt", "a folder, not a file");
          yield* write(".agents/skills/.dotted/SKILL.md", skillFile("dotted", "Dotted."));
          yield* write(".agents/skills/some file.txt", "not a folder");
          const { skills } = yield* withCatalog(home, (catalog) => catalog.list({ cwd: project }));
          const names = skills
            .filter((skill) => skill.scope === "global")
            .map((skill) => skill.name);
          for (const skipped of ["lowercase", "broken", "odd", ".dotted", "not-a-skill", ".hidden"])
            expect(names).not.toContain(skipped);
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "accepts the folder names the agents' scanners accept, such as ones with spaces",
      () =>
        Effect.gen(function* () {
          const { home, write } = yield* makeMachine;
          for (const name of ["my skill", "Name_1.2", "plus+sign", "ünï"])
            yield* write(`.agents/skills/${name}/SKILL.md`, skillFile(name, "Odd name."));
          const { skills } = yield* withCatalog(home, (catalog) => catalog.list({}));
          const names = skills.map((skill) => skill.name);
          for (const name of ["my skill", "Name_1.2", "plus+sign", "ünï"])
            expect(names).toContain(name);
          const detail = yield* withCatalog(home, (catalog) =>
            catalog.get({ scope: "global", name: "my skill", home: "~/.agents/skills/my skill" }),
          );
          expect(detail.home).toBe(`${home}/.agents/skills/my skill`);
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "reads descriptions the way Claude Code reads a header",
      () =>
        Effect.gen(function* () {
          const { home, write } = yield* makeMachine;
          const header = (name: string, body: string) =>
            write(`.agents/skills/${name}/SKILL.md`, `---\nname: ${name}\n${body}\n---\nBody\n`);
          yield* header("quoted", 'description: "Say \\"hi\\" often"');
          yield* header("folded", "description: >-\n  one\n  two");
          yield* header("literal", "description: |\n  line one\n  line two");
          // YAML rejects an unquoted colon; Claude Code, and so the page, still reads it.
          yield* header("colon", "description: Use when: testing");
          yield* header("spaced", "description:   spaced    out");
          yield* header("none", "other: value");
          yield* write(".agents/skills/no-header/SKILL.md", "# No header\n");
          yield* write(
            ".agents/skills/windows/SKILL.md",
            "---\r\nname: x\r\ndescription: crlf\r\n---\r\n",
          );
          const { skills } = yield* withCatalog(home, (catalog) => catalog.list({}));
          const described = Object.fromEntries(
            skills.map((skill) => [skill.name, skill.description]),
          );
          expect(described).toMatchObject({
            quoted: 'Say "hi" often',
            folded: "one two",
            literal: "line one line two",
            colon: "Use when: testing",
            spaced: "spaced out",
            none: "",
            "no-header": "",
            windows: "crlf",
          });
          expect(skills.every((skill) => skill.invalidHeader === undefined)).toBe(true);
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "reports a header Claude Code can't read, and Claude doesn't load the skill",
      () =>
        Effect.gen(function* () {
          const { home, project, write } = yield* makeMachine;
          yield* write(
            ".claude/skills/broken-header/SKILL.md",
            "---\nname: broken-header\ndescription: [never closed\n---\nBody\n",
          );
          // A header Claude skips doesn't shadow a later copy of the same name.
          yield* write(
            ".claude/skills/dup/SKILL.md",
            "---\ndescription: [never closed\n---\nGlobal.\n",
          );
          yield* write("repos/app/.claude/skills/dup/SKILL.md", skillFile("dup", "Project copy."));
          const { skills } = yield* withCatalog(home, (catalog) => catalog.list({ cwd: project }));
          const byName = byKey(skills);

          const broken = byName.get("global:broken-header");
          expect(broken).toMatchObject({ invalidHeader: true, description: "" });
          expect(states(broken)).toMatchObject({ claudeAgent: "none", cursor: "direct" });

          expect(byName.get("global:dup")).toMatchObject({ invalidHeader: true });
          expect(states(byName.get("global:dup")).claudeAgent).toBe("none");
          expect(states(byName.get("project:dup")).claudeAgent).toBe("direct");
          expect(byName.get("project:dup")?.invalidHeader).toBeUndefined();
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "shows a skill that Claude's own settings switch off as off for Claude",
      () =>
        Effect.gen(function* () {
          const { home, project, write } = yield* makeMachine;
          // The user's file switches two skills off, by folder name, and keeps one reachable by
          // the user only; the project's local file turns one of the two back on and switches off
          // a project skill.
          yield* write(
            ".claude/settings.json",
            JSON.stringify({
              skillOverrides: {
                cloudflare: "off",
                architect: "off",
                "user-only": "user-invocable-only",
              },
            }),
          );
          yield* write(
            "repos/app/.claude/settings.local.json",
            JSON.stringify({ skillOverrides: { architect: "on", "own-copy": "off" } }),
          );
          yield* write(".claude/skills/user-only/SKILL.md", skillFile("user-only", "By hand."));
          const { skills } = yield* withCatalog(home, (catalog) => catalog.list({ cwd: project }));
          const byName = byKey(skills);

          // Off: Claude can see it but doesn't use it, the others still do.
          expect(accessOf(byName.get("global:cloudflare"))).toMatchObject({
            claudeAgent: { state: "off", folder: "~/.claude/skills" },
            cursor: { state: "direct", folder: "~/.claude/skills" },
          });
          // The project's later layer turns the user's "off" back on.
          expect(states(byName.get("global:architect")).claudeAgent).toBe("link");
          expect(states(byName.get("project:own-copy")).claudeAgent).toBe("off");
          // The user can still invoke a skill that only the model is kept from.
          expect(states(byName.get("global:user-only")).claudeAgent).toBe("direct");

          // Without the project, only the user's layer applies.
          const global = yield* withCatalog(home, (catalog) => catalog.list({}));
          expect(states(byKey(global.skills).get("global:architect")).claudeAgent).toBe("off");
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "flags a name that exists more than once, and whether the copies are identical",
      () =>
        Effect.gen(function* () {
          const { home, project } = yield* makeMachine;
          const { skills } = yield* withCatalog(home, (catalog) => catalog.list({ cwd: project }));
          const byName = byKey(skills);
          expect(byName.get("project:tdd")?.copies).toEqual([
            { scope: "global", home: "~/Knowledge/skills/tdd", same: false },
          ]);
          expect(byName.get("global:tdd")?.copies).toEqual([
            { scope: "project", home: ".agents/skills/tdd", same: false },
          ]);
          expect(byName.get("project:shared")?.copies).toEqual([
            { scope: "global", home: "~/Knowledge/skills/shared", same: true },
          ]);
          expect(byName.get("global:shared")?.copies).toEqual([
            { scope: "project", home: ".agents/skills/shared", same: true },
          ]);
          expect(byName.get("project:verify")?.copies).toEqual([]);
          expect(byName.get("global:architect")?.copies).toEqual([]);

          // Without a project there is no second scope to compare with.
          const globalOnly = yield* withCatalog(home, (catalog) => catalog.list({}));
          expect(globalOnly.skills.every((skill) => skill.scope === "global")).toBe(true);
          expect(globalOnly.skills.every((skill) => skill.copies.length === 0)).toBe(true);
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "gives a copy to an agent only when the agent loads it, and flags copies that differ",
      () =>
        Effect.gen(function* () {
          const { home, project, write } = yield* makeMachine;
          yield* write(
            "repos/app/.claude/skills/tdd/SKILL.md",
            skillFile("tdd", "Claude's own tdd."),
          );
          const { skills } = yield* withCatalog(home, (catalog) => catalog.list({ cwd: project }));
          const tdds = skills.filter((skill) => skill.scope === "project" && skill.name === "tdd");
          expect(tdds.map((skill) => skill.home).toSorted()).toEqual([
            ".agents/skills/tdd",
            ".claude/skills/tdd",
          ]);
          const shared = tdds.find((skill) => skill.home === ".agents/skills/tdd");
          const claudes = tdds.find((skill) => skill.home === ".claude/skills/tdd");

          // Claude reads its own folder, so the copy in `.claude/skills` is the one it loads.
          expect(accessOf(claudes).claudeAgent).toEqual({
            state: "direct",
            folder: ".claude/skills",
          });
          expect(accessOf(shared).claudeAgent?.state).toBe("none");
          // Cursor looks in the project's `.agents/skills` before its `.claude/skills`.
          expect(accessOf(shared).cursor).toEqual({ state: "direct", folder: ".agents/skills" });
          expect(accessOf(claudes).cursor?.state).toBe("none");
          // Codex loads every copy of a name, from the folders it reads: the project's shared one
          // and the global one, but not `.claude/skills`.
          expect(accessOf(shared).codex).toEqual({ state: "direct", folder: ".agents/skills" });
          expect(accessOf(claudes).codex?.state).toBe("none");
          expect(accessOf(byKey(skills).get("global:tdd")).codex).toEqual({
            state: "direct",
            folder: "~/.agents/skills",
          });

          // All three project and global copies differ from each other, so each is a conflict.
          for (const copy of [...tdds, byKey(skills).get("global:tdd")]) {
            expect(copy?.copies.length).toBe(2);
            expect(copy?.copies.every((other) => !other.same)).toBe(true);
          }
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "loads one copy of a name for agents that take the first, and every copy for the others",
      () =>
        Effect.gen(function* () {
          const { home, project } = yield* makeMachine;
          const { skills } = yield* withCatalog(home, (catalog) => catalog.list({ cwd: project }));
          const byName = byKey(skills);
          // Cursor and Pi look in the project first and take the first copy; Antigravity doesn't
          // read the global standard folder. Codex and OpenCode list every copy, and Grok reads
          // no project `.agents/skills`.
          expect(states(byName.get("project:tdd"))).toMatchObject({
            cursor: "direct",
            antigravity: "direct",
            pi: "direct",
            codex: "direct",
            opencode: "direct",
            grok: "none",
          });
          expect(states(byName.get("global:tdd"))).toMatchObject({
            cursor: "none",
            antigravity: "none",
            pi: "none",
            codex: "direct",
            opencode: "direct",
            grok: "direct",
          });
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "gives a project and a global skill of one name to Codex, which loads both, and flags them",
      () =>
        Effect.gen(function* () {
          const { home, project, write } = yield* makeMachine;
          yield* write(
            "repos/app/.agents/skills/grill-me/SKILL.md",
            skillFile("grill-me", "Project grilling."),
          );
          yield* write(
            ".agents/skills/grill-me/SKILL.md",
            skillFile("grill-me", "Global grilling."),
          );
          const { skills } = yield* withCatalog(home, (catalog) => catalog.list({ cwd: project }));
          const byName = byKey(skills);
          const projectCopy = byName.get("project:grill-me");
          const globalCopy = byName.get("global:grill-me");

          for (const copy of [projectCopy, globalCopy]) {
            expect(accessOf(copy).codex).toEqual({
              state: "direct",
              folder: copy?.scope === "project" ? ".agents/skills" : "~/.agents/skills",
            });
            expect(copy?.copies.map((other) => other.same)).toEqual([false]);
          }
          // Cursor and Pi take the project copy and not the global one.
          for (const agent of ["cursor", "pi"] as const) {
            expect(states(projectCopy)[agent]).toBe("direct");
            expect(states(globalCopy)[agent]).toBe("none");
          }
          // Grok doesn't read the project's standard folder, so only the global copy reaches it.
          expect(states(projectCopy).grok).toBe("none");
          expect(states(globalCopy).grok).toBe("direct");
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "follows the config folders that enabled provider instances move, one entry per instance",
      () =>
        Effect.gen(function* () {
          const { home, write } = yield* makeMachine;
          yield* write("work-claude/skills/work-only/SKILL.md", skillFile("work-only", "Work."));
          yield* write("env-claude/skills/env-only/SKILL.md", skillFile("env-only", "Env."));
          yield* write("codex-alt/skills/codex-only/SKILL.md", skillFile("codex-only", "Codex."));
          yield* write("grok-alt/skills/grok-only/SKILL.md", skillFile("grok-only", "Grok."));
          yield* write(".pi/agent/skills/pi-only/SKILL.md", skillFile("pi-only", "Pi."));
          const settings = {
            providerInstances: {
              // The instance's own setting wins over CLAUDE_CONFIG_DIR.
              [ProviderInstanceId.make("claude_work")]: {
                driver: ProviderDriverKind.make("claudeAgent"),
                displayName: "Claude Work",
                config: { homePath: `${home}/work-claude` },
              },
              // A disabled instance isn't an agent here, and its folders aren't read.
              [ProviderInstanceId.make("pi")]: {
                driver: ProviderDriverKind.make("pi"),
                enabled: false,
              },
            },
          };
          const { skills } = yield* withCatalog(home, (catalog) => catalog.list({}), {
            settings,
            env: {
              CLAUDE_CONFIG_DIR: `${home}/env-claude`,
              CODEX_HOME: `${home}/codex-alt`,
              GROK_HOME: `${home}/grok-alt`,
            },
          });
          const byName = byKey(skills);

          expect(skills[0]?.access.map((entry) => entry.instanceId)).toEqual([
            "claude_work",
            "claudeAgent",
            "codex",
            "cursor",
            "grok",
            "opencode",
            "antigravity",
          ]);
          expect(accessOf(byName.get("global:work-only"))).toMatchObject({
            claude_work: { state: "direct", folder: "~/work-claude/skills" },
            claudeAgent: { state: "none", folder: "~/env-claude/skills" },
          });
          expect(accessOf(byName.get("global:env-only"))).toMatchObject({
            claude_work: { state: "none", folder: "~/work-claude/skills" },
            claudeAgent: { state: "direct", folder: "~/env-claude/skills" },
          });
          expect(accessOf(byName.get("global:codex-only")).codex).toEqual({
            state: "direct",
            folder: "~/codex-alt/skills",
          });
          expect(accessOf(byName.get("global:grok-only")).grok).toEqual({
            state: "direct",
            folder: "~/grok-alt/skills",
          });
          expect(byName.has("global:pi-only")).toBe(false);
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "caps the description at 160 characters and marks the cut",
      () =>
        Effect.gen(function* () {
          const { home, write } = yield* makeMachine;
          yield* write(".agents/skills/wordy/SKILL.md", skillFile("wordy", `"${"x".repeat(300)}"`));
          yield* write(".agents/skills/exact/SKILL.md", skillFile("exact", `"${"x".repeat(160)}"`));
          // The cap counts characters, not UTF-16 units: an emoji is one.
          yield* write(
            ".agents/skills/emoji/SKILL.md",
            skillFile("emoji", `"${"🙂".repeat(200)}"`),
          );
          // A description longer than the first read still finishes its header.
          yield* write(".agents/skills/epic/SKILL.md", skillFile("epic", `"${"y".repeat(5_000)}"`));
          // One that outgrows even the second read has no description, but the skill stays.
          yield* write(
            ".agents/skills/endless/SKILL.md",
            skillFile("endless", `"${"z".repeat(40_000)}"`),
          );
          const { skills } = yield* withCatalog(home, (catalog) => catalog.list({}));
          const byName = byKey(skills);
          expect(byName.get("global:wordy")?.description).toBe(`${"x".repeat(160)}…`);
          expect(byName.get("global:exact")?.description).toBe("x".repeat(160));
          expect(byName.get("global:emoji")?.description).toBe(`${"🙂".repeat(160)}…`);
          expect(byName.get("global:epic")?.description).toBe(`${"y".repeat(160)}…`);
          expect(byName.get("global:endless")?.description).toBe("");
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "reports folders it can't read, but not ones that don't exist",
      () =>
        Effect.gen(function* () {
          const { home, project, write } = yield* makeMachine;
          // A file where the folder should be can't be listed, on any platform and for any user.
          yield* write(".gemini/config/skills", "not a folder");
          yield* write("repos/app/.pi/skills", "not a folder");
          const result = yield* withCatalog(home, (catalog) => catalog.list({ cwd: project }));
          expect(result.unreadable).toEqual(
            expect.arrayContaining([
              { scope: "global", folder: "~/.gemini/config/skills" },
              { scope: "project", folder: ".pi/skills" },
            ]),
          );
          // `.codex/skills`, `.grok/skills` and the others simply aren't there.
          expect(result.unreadable).toHaveLength(2);
          // The rest of the list is unaffected.
          expect(byKey(result.skills).has("global:architect")).toBe(true);
          expect(byKey(result.skills).has("project:verify")).toBe(true);
        }),
    );

    it.effect.skipIf(!symlinksSupported)("reads at most 1000 skill folders from one folder", () =>
      Effect.gen(function* () {
        const { home, write } = yield* makeMachine;
        yield* Effect.forEach(
          Array.from({ length: 1_005 }, (_, index) => `bulk-${String(index).padStart(4, "0")}`),
          (name) => write(`.codex/skills/${name}/SKILL.md`, skillFile(name, "Bulk.")),
          { concurrency: 16, discard: true },
        );
        const { skills } = yield* withCatalog(home, (catalog) => catalog.list({}));
        expect(skills.filter((skill) => skill.name.startsWith("bulk-"))).toHaveLength(1_000);
      }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "refuses a SKILL.md that is a link out of the skill, and reads one that stays inside",
      () =>
        Effect.gen(function* () {
          const { home, write, link } = yield* makeMachine;
          yield* write(
            "outside/SKILL.md",
            "---\ndescription: Secret from outside.\n---\nTop secret.\n",
          );
          yield* write(".agents/skills/escaping/notes.md", "# notes\n");
          yield* link("outside/SKILL.md", ".agents/skills/escaping/SKILL.md");
          yield* write(
            ".agents/skills/inside/README.md",
            "---\ndescription: Linked inside.\n---\nBody.\n",
          );
          yield* link(".agents/skills/inside/README.md", ".agents/skills/inside/SKILL.md");

          const { skills } = yield* withCatalog(home, (catalog) => catalog.list({}));
          const byName = byKey(skills);
          expect(byName.has("global:escaping")).toBe(false);
          expect(byName.get("global:inside")?.description).toBe("Linked inside.");

          const escaping = yield* withCatalog(home, (catalog) =>
            catalog.get({ scope: "global", name: "escaping", home: "~/.agents/skills/escaping" }),
          );
          expect(escaping.contents).toBeNull();
          expect(escaping.description).toBe("");
          const inside = yield* withCatalog(home, (catalog) =>
            catalog.get({ scope: "global", name: "inside", home: "~/.agents/skills/inside" }),
          );
          expect(inside.contents).toContain("Linked inside.");
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "never writes, and returns results the RPC success schema can encode",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const { home, project } = yield* makeMachine;
          const before = yield* fs.readDirectory(home, { recursive: true });
          const result = yield* withCatalog(home, (catalog) => catalog.list({ cwd: project }));
          const encoded = yield* encodeList(result);
          expect(encoded.skills).toHaveLength(result.skills.length);
          expect(encoded.skills[0]?.access.map((entry) => entry.instanceId)).toEqual([
            "claudeAgent",
            "codex",
            "cursor",
            "grok",
            "opencode",
            "antigravity",
            "pi",
          ]);
          expect(encoded.skills[0]?.access.map((entry) => entry.driver)).toEqual([
            "claudeAgent",
            "codex",
            "cursor",
            "grok",
            "opencode",
            "antigravity",
            "pi",
          ]);
          const detail = yield* withCatalog(home, (catalog) =>
            catalog.get({
              cwd: project,
              scope: "project",
              name: "verify",
              home: ".agents/skills/verify",
            }),
          );
          expect((yield* encodeGet(detail)).files).toHaveLength(3);
          expect(yield* fs.readDirectory(home, { recursive: true })).toEqual(before);
        }),
    );
  });

  describe("project folders", () => {
    it.effect(
      "refuses a folder that is gone as not a project, and dies on a failure of the lookup itself",
      () =>
        Effect.gen(function* () {
          const { home } = yield* makeMachine;
          const projects = Layer.mock(ProjectService.ProjectService)({
            getByWorkspaceRoot: (root) =>
              Effect.fail(
                new ProjectOperationError({
                  operation: root.endsWith("/gone") ? "normalize-workspace" : "list-projects",
                  workspaceRoot: root,
                  cause: "stand-in",
                }),
              ),
          });
          const onMachine = <A, E>(
            use: (catalog: SkillCatalog.SkillCatalog["Service"]) => Effect.Effect<A, E>,
          ) =>
            Effect.gen(function* () {
              return yield* use(yield* SkillCatalog.SkillCatalog);
            }).pipe(
              Effect.provide(
                SkillCatalog.layer.pipe(
                  Layer.provide(Layer.mergeAll(projects, Settings.layerTest({}))),
                ),
              ),
              Effect.provideService(HostProcess.Environment, { HOME: home }),
            );

          const gone = yield* onMachine((catalog) =>
            catalog.list({ cwd: `${home}/gone` }).pipe(Effect.flip),
          );
          expect(gone).toEqual(new SkillRequestError({ reason: "projectNotRegistered" }));

          const failed = yield* onMachine((catalog) =>
            catalog.list({ cwd: `${home}/there` }).pipe(Effect.exit),
          );
          expect(Exit.isFailure(failed) && Cause.hasDies(failed.cause)).toBe(true);
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "reads a project's skill folders only when the folder is a registered project",
      () =>
        Effect.gen(function* () {
          const { home, project } = yield* makeMachine;
          const refused = new SkillRequestError({ reason: "projectNotRegistered" });
          const get = (cwd: string) => ({
            cwd,
            scope: "project" as const,
            name: "verify",
            home: ".agents/skills/verify",
          });

          // A folder that holds skills but isn't a project (the home, a project's subfolder, a
          // relative path, a path that isn't there) is refused for the list and for one skill.
          for (const cwd of [home, `${project}/.agents`, "repos/app", `${home}/missing`]) {
            const registered = [project];
            expect(
              yield* withCatalog(home, (catalog) => catalog.list({ cwd }).pipe(Effect.flip), {
                registered,
              }),
            ).toEqual(refused);
            expect(
              yield* withCatalog(home, (catalog) => catalog.get(get(cwd)).pipe(Effect.flip), {
                registered,
              }),
            ).toEqual(refused);
          }

          // The registered project, and the Global folders without any `cwd`, are read as before.
          const listed = yield* withCatalog(home, (catalog) => catalog.list({ cwd: project }));
          expect(listed.skills.some((skill) => skill.scope === "project")).toBe(true);
          const global = yield* withCatalog(home, (catalog) => catalog.list({}), {
            registered: [],
          });
          expect(global.skills.map((skill) => skill.scope)).toEqual(
            global.skills.map(() => "global"),
          );
          expect(global.skills.length).toBeGreaterThan(0);
          const detail = yield* withCatalog(home, (catalog) => catalog.get(get(project)));
          expect(detail.home).toBe(`${project}/.agents/skills/verify`);
        }),
    );
  });

  describe("what can be moved or deleted", () => {
    it.effect.skipIf(!symlinksSupported)(
      "marks a skill whose folder sits in an agent's folder, and not one reached through a link",
      () =>
        Effect.gen(function* () {
          const { home, project } = yield* makeMachine;
          const { skills } = yield* withCatalog(home, (catalog) => catalog.list({ cwd: project }));
          const byName = byKey(skills);

          expect(byName.get("project:verify")?.realFolder).toBe(true);
          expect(byName.get("project:own-copy")?.realFolder).toBe(true);
          expect(byName.get("global:cloudflare")?.realFolder).toBe(true);
          // The library's skills are linked into the shared folder, so they live elsewhere.
          expect(byName.get("global:architect")?.realFolder).toBeUndefined();
          expect(byName.get("global:tdd")?.realFolder).toBeUndefined();
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "doesn't call a folder reached through a linked skills folder a real one",
      () =>
        Effect.gen(function* () {
          const { home, project, write, link } = yield* makeMachine;
          yield* write("elsewhere/relay/SKILL.md", skillFile("relay", "Reached through a link."));
          // The project's whole `.cursor/skills` folder is a link to another folder.
          yield* link("elsewhere", "repos/app/.cursor/skills");
          const { skills } = yield* withCatalog(home, (catalog) => catalog.list({ cwd: project }));

          expect(byKey(skills).get("project:relay")).toMatchObject({ name: "relay" });
          expect(byKey(skills).get("project:relay")?.realFolder).toBeUndefined();
        }),
    );
  });

  describe("get", () => {
    it.effect.skipIf(!symlinksSupported)(
      "returns the full SKILL.md, the file list and which files can run",
      () =>
        Effect.gen(function* () {
          const { home, project } = yield* makeMachine;
          const detail = yield* withCatalog(home, (catalog) =>
            catalog.get({
              cwd: project,
              scope: "project",
              name: "verify",
              home: ".agents/skills/verify",
            }),
          );
          expect(detail.home).toBe(`${project}/.agents/skills/verify`);
          expect(detail.description).toBe("Drive the app in a browser and capture evidence.");
          expect(detail.contents).toContain("# verify");
          expect(detail.files).toEqual([
            { path: "SKILL.md", size: expect.any(Number), executable: false },
            { path: "bin/run", size: expect.any(Number), executable: true },
            { path: "lib/serve.mjs", size: expect.any(Number), executable: false },
          ]);
          expect(detail.filesTruncated).toBe(false);
          // A skill reached through a link resolves to the library folder.
          const linked = yield* withCatalog(home, (catalog) =>
            catalog.get({
              scope: "global",
              name: "architect",
              home: "~/Knowledge/skills/architect",
            }),
          );
          expect(linked.home).toBe(`${home}/Knowledge/skills/architect`);
          expect(linked.files.map((file) => file.path)).toEqual(["SKILL.md", "refs/principles.md"]);
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "picks the skill that matches the home the list returned",
      () =>
        Effect.gen(function* () {
          const { home, project, write } = yield* makeMachine;
          yield* write(
            "repos/app/.claude/skills/tdd/SKILL.md",
            skillFile("tdd", "Claude's own tdd."),
          );
          const read = (folder: string) =>
            withCatalog(home, (catalog) =>
              catalog.get({ cwd: project, scope: "project", name: "tdd", home: `${folder}/tdd` }),
            );
          expect((yield* read(".claude/skills")).contents).toContain("Claude's own tdd.");
          expect((yield* read(".agents/skills")).contents).toContain("Project test loop.");
          expect((yield* read(".pi/skills")).home).toBeNull();
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "bounds the files it lists and skips folders it shouldn't walk",
      () =>
        Effect.gen(function* () {
          const { home, write } = yield* makeMachine;
          yield* write(".agents/skills/big/SKILL.md", skillFile("big", "Many files."));
          yield* Effect.forEach(
            Array.from(
              { length: 520 },
              (_, index) => `refs/note-${String(index).padStart(3, "0")}.md`,
            ),
            (file) => write(`.agents/skills/big/${file}`, "note\n"),
            { concurrency: 16, discard: true },
          );
          yield* write(".agents/skills/big/node_modules/dep/index.js", "module.exports = {};\n");
          yield* write(".agents/skills/big/.git/HEAD", "ref: refs/heads/main\n");
          const detail = yield* withCatalog(home, (catalog) =>
            catalog.get({ scope: "global", name: "big", home: "~/.agents/skills/big" }),
          );
          expect(detail.files).toHaveLength(500);
          expect(detail.filesTruncated).toBe(true);
          expect(detail.files.some((file) => /node_modules|\.git/.test(file.path))).toBe(false);
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "stops walking after a fixed number of folders, however many a skill has",
      () =>
        Effect.gen(function* () {
          const { home, write } = yield* makeMachine;
          yield* write(".agents/skills/wide/SKILL.md", skillFile("wide", "Many folders."));
          yield* Effect.forEach(
            Array.from({ length: 300 }, (_, index) => `d-${String(index).padStart(3, "0")}`),
            (folder) => write(`.agents/skills/wide/${folder}/note.md`, "note\n"),
            { concurrency: 16, discard: true },
          );
          const detail = yield* withCatalog(home, (catalog) =>
            catalog.get({ scope: "global", name: "wide", home: "~/.agents/skills/wide" }),
          );
          // SKILL.md and the first 199 folders' files: 200 folders are walked in all, root included.
          expect(detail.files).toHaveLength(200);
          expect(detail.files.some((file) => file.path.startsWith("d-198/"))).toBe(true);
          expect(detail.files.some((file) => file.path.startsWith("d-199/"))).toBe(false);
          expect(detail.filesTruncated).toBe(true);
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "stops at the file limit in one huge folder instead of looking at every entry",
      () =>
        Effect.gen(function* () {
          const { home, write } = yield* makeMachine;
          yield* write(".agents/skills/flat/SKILL.md", skillFile("flat", "One big folder."));
          yield* Effect.forEach(
            Array.from({ length: 1_100 }, (_, index) => `n-${String(index).padStart(4, "0")}.md`),
            (file) => write(`.agents/skills/flat/${file}`, "note\n"),
            { concurrency: 16, discard: true },
          );
          const detail = yield* withCatalog(home, (catalog) =>
            catalog.get({ scope: "global", name: "flat", home: "~/.agents/skills/flat" }),
          );
          expect(detail.files).toHaveLength(500);
          expect(detail.files[0]?.path).toBe("SKILL.md");
          expect(detail.files.at(-1)?.path).toBe("n-0498.md");
          expect(detail.filesTruncated).toBe(true);
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "lists a link inside a skill as one file and doesn't follow it",
      () =>
        Effect.gen(function* () {
          const { home, link } = yield* makeMachine;
          yield* link("Knowledge/skills/architect", "Knowledge/skills/grill/shortcut");
          const detail = yield* withCatalog(home, (catalog) =>
            catalog.get({ scope: "global", name: "grill", home: "~/Knowledge/skills/grill" }),
          );
          expect(detail.files).toEqual([
            { path: "SKILL.md", size: expect.any(Number), executable: false },
            { path: "shortcut", size: 0, executable: false },
          ]);
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "shows no SKILL.md text when the file is too large, but still lists the skill",
      () =>
        Effect.gen(function* () {
          const { home, write } = yield* makeMachine;
          yield* write(
            ".agents/skills/huge/SKILL.md",
            `${skillFile("huge", "Huge file.")}${"x".repeat(1024 * 1024)}`,
          );
          const { skills } = yield* withCatalog(home, (catalog) => catalog.list({}));
          expect(byKey(skills).get("global:huge")?.description).toBe("Huge file.");
          const detail = yield* withCatalog(home, (catalog) =>
            catalog.get({ scope: "global", name: "huge", home: "~/.agents/skills/huge" }),
          );
          expect(detail.contents).toBeNull();
          expect(detail.description).toBe("Huge file.");
          expect(detail.files.map((file) => file.path)).toEqual(["SKILL.md"]);
        }),
    );

    it.effect.skipIf(!symlinksSupported)("only reads names the agents' scanners accept", () =>
      Effect.gen(function* () {
        const { home } = yield* makeMachine;
        const names = [
          "../Knowledge/skills/architect",
          "..",
          ".",
          "",
          ".hidden",
          "a/b",
          "a\\b",
          "nul\0name",
          "nope",
        ];
        for (const name of names) {
          const detail = yield* withCatalog(home, (catalog) =>
            catalog.get({ scope: "global", name, home: `~/.agents/skills/${name}` }),
          );
          expect(detail).toEqual(NOT_FOUND);
        }
        // A project scope with no project asks for nothing.
        const noProject = yield* withCatalog(home, (catalog) =>
          catalog.get({ scope: "project", name: "verify", home: ".agents/skills/verify" }),
        );
        expect(noProject.home).toBeNull();
        // The home to match is a label the list returned, not a path to read.
        const elsewhere = yield* withCatalog(home, (catalog) =>
          catalog.get({ scope: "global", name: "cloudflare", home: "/etc" }),
        );
        expect(elsewhere.home).toBeNull();
        expect((yield* encodeGet(elsewhere)).home).toBeNull();
      }),
    );
  });
});
