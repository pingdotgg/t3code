import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { InstructionAgentsResult, InstructionWriteResult } from "@t3tools/contracts";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

import { parseSettingsJson } from "./ClaudeInstructionSetting.ts";
import { adoptedText } from "./InstructionManager.ts";
import * as InstructionCatalog from "./InstructionCatalog.ts";
import * as InstructionManager from "./InstructionManager.ts";
import * as InstructionTracking from "./InstructionTracking.ts";
import {
  ALL_AGENTS,
  agent,
  layerFor,
  makeMachine,
  type MachineOptions,
} from "./testing/machine.ts";
import * as ProcessRunner from "../processRunner.ts";

const encodeWrite = Schema.encodeUnknownEffect(InstructionWriteResult);
const encodeAgents = Schema.encodeUnknownEffect(InstructionAgentsResult);

const CLAUDE = { versions: { claudeAgent: "2.1.291" } } satisfies MachineOptions;

const onMachine = <A, E, R>(
  home: string,
  options: MachineOptions,
  use: (services: {
    readonly manager: InstructionManager.InstructionManager["Service"];
    readonly catalog: InstructionCatalog.InstructionCatalog["Service"];
    readonly tracking: InstructionTracking.InstructionTracking["Service"];
  }) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    return yield* use({
      manager: yield* InstructionManager.InstructionManager,
      catalog: yield* InstructionCatalog.InstructionCatalog,
      tracking: yield* InstructionTracking.InstructionTracking,
    });
  }).pipe(Effect.provide(layerFor(home, options)));

const stateOf = (
  catalog: InstructionCatalog.InstructionCatalog["Service"],
  id: string,
  cwd?: string,
) =>
  catalog
    .list(cwd === undefined ? {} : { cwd })
    .pipe(
      Effect.map(({ entries }) =>
        Object.fromEntries(
          (entries.find((entry) => entry.id === id)?.access ?? []).map((access) => [
            access.instanceId,
            access.state,
          ]),
        ),
      ),
    );

const agents = (...names: string[]) => names.map((name) => agent(name));

it.layer(NodeServices.layer, { excludeTestServices: true })("InstructionManager", (it) => {
  describe("write", () => {
    it.effect("creates a missing file, then refuses to create it again", () =>
      Effect.gen(function* () {
        const { home, project, read } = yield* makeMachine;
        yield* onMachine(home, { ...CLAUDE, registered: [project] }, ({ manager }) =>
          Effect.gen(function* () {
            const created = yield* manager.write({
              cwd: project,
              id: "project:shared:AGENTS.md",
              contents: "# Rules\n",
              expectedRevision: null,
            });
            yield* encodeWrite(created);

            expect(yield* read("repos/app/AGENTS.md")).toBe("# Rules\n");
            expect(created.revision).toMatch(/^[0-9a-f]{64}$/);
            const again = yield* manager
              .write({
                cwd: project,
                id: "project:shared:AGENTS.md",
                contents: "other",
                expectedRevision: null,
              })
              .pipe(Effect.flip);
            expect(again.reason).toBe("exists");
            expect(yield* read("repos/app/AGENTS.md")).toBe("# Rules\n");
          }),
        );
      }),
    );

    it.effect("keeps a new CLAUDE.local.md out of git, and a new AGENTS.md in", () =>
      Effect.gen(function* () {
        const { home, project, fs, path } = yield* makeMachine;
        const processRunner = yield* ProcessRunner.ProcessRunner;
        yield* processRunner.run({ command: "git", args: ["-C", project, "init", "-q"] });
        yield* onMachine(home, { ...CLAUDE, registered: [project] }, ({ manager }) =>
          Effect.gen(function* () {
            for (const id of ["project:claudeLocal:CLAUDE.local.md", "project:shared:AGENTS.md"]) {
              yield* manager.write({ cwd: project, id, contents: "notes", expectedRevision: null });
            }
          }),
        );
        const ignored = (file: string) =>
          processRunner
            .run({
              command: "git",
              args: ["-C", project, "check-ignore", "-q", file],
            })
            .pipe(Effect.map((result) => result.code === 0));
        expect(yield* ignored("CLAUDE.local.md")).toBe(true);
        expect(yield* ignored("AGENTS.md")).toBe(false);
        expect(yield* fs.exists(path.join(project, "CLAUDE.local.md"))).toBe(true);
      }).pipe(Effect.provide(ProcessRunner.layer)),
    );

    it.effect("replaces a file only when its revision is still the one that was read", () =>
      Effect.gen(function* () {
        const { home, project, write, read } = yield* makeMachine;
        yield* write("repos/app/AGENTS.md", "first");
        yield* onMachine(home, { ...CLAUDE, registered: [project] }, ({ manager, catalog }) =>
          Effect.gen(function* () {
            const id = "project:shared:AGENTS.md";
            const opened = yield* catalog.read({ cwd: project, id });

            const saved = yield* manager.write({
              cwd: project,
              id,
              contents: "second",
              expectedRevision: opened.revision,
            });
            expect(yield* read("repos/app/AGENTS.md")).toBe("second");
            expect(saved.revision).not.toBe(opened.revision);
            expect((yield* catalog.read({ cwd: project, id })).revision).toBe(saved.revision);

            // Someone else edited the file after it was opened.
            yield* write("repos/app/AGENTS.md", "edited elsewhere");
            const stale = yield* manager
              .write({ cwd: project, id, contents: "third", expectedRevision: saved.revision })
              .pipe(Effect.flip);
            expect(stale.reason).toBe("changedOnDisk");
            expect(yield* read("repos/app/AGENTS.md")).toBe("edited elsewhere");

            // A file that was there and is gone is a change too.
            const gone = yield* manager
              .write({
                cwd: project,
                id: "project:claude:CLAUDE.md",
                contents: "x",
                expectedRevision: saved.revision,
              })
              .pipe(Effect.flip);
            expect(gone.reason).toBe("changedOnDisk");
          }),
        );
      }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "writes through a link to the real file and keeps the link",
      () =>
        Effect.gen(function* () {
          const { home, project, write, link, fs, path, read } = yield* makeMachine;
          yield* write(".agents/AGENTS.md", "shared");
          yield* link(".agents/AGENTS.md", "repos/app/CLAUDE.md");
          yield* onMachine(home, { ...CLAUDE, registered: [project] }, ({ manager, catalog }) =>
            Effect.gen(function* () {
              const id = "project:claude:CLAUDE.md";
              const opened = yield* catalog.read({ cwd: project, id });
              yield* manager.write({
                cwd: project,
                id,
                contents: "shared, edited",
                expectedRevision: opened.revision,
              });

              expect(yield* read(".agents/AGENTS.md")).toBe("shared, edited");
              expect(yield* fs.readLink(path.join(project, "CLAUDE.md"))).toBe(
                path.join(home, ".agents/AGENTS.md"),
              );
              // No temp file was left in either folder.
              expect(yield* fs.readDirectory(path.join(home, ".agents"))).toEqual(["AGENTS.md"]);
              expect(yield* fs.readDirectory(project)).toEqual(["CLAUDE.md"]);
            }),
          );
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "creates the real file behind a link that leads nowhere",
      () =>
        Effect.gen(function* () {
          const { home, fs, path, read } = yield* makeMachine;
          yield* fs.makeDirectory(path.join(home, ".codex"), { recursive: true });
          yield* fs.symlink(
            path.join(home, ".agents/AGENTS.md"),
            path.join(home, ".codex/AGENTS.md"),
          );
          yield* onMachine(home, CLAUDE, ({ manager }) =>
            Effect.gen(function* () {
              yield* manager.write({
                id: "global:shared",
                contents: "hello",
                expectedRevision: null,
              });
              expect(yield* read(".agents/AGENTS.md")).toBe("hello");
              expect(yield* fs.readLink(path.join(home, ".codex/AGENTS.md"))).toBe(
                path.join(home, ".agents/AGENTS.md"),
              );
            }),
          );
        }),
    );

    it.effect("keeps a file's permissions", () =>
      Effect.gen(function* () {
        const { home, project, write, fs, path } = yield* makeMachine;
        yield* write("repos/app/AGENTS.md", "first");
        yield* fs.chmod(path.join(project, "AGENTS.md"), 0o600);
        yield* onMachine(home, { ...CLAUDE, registered: [project] }, ({ manager, catalog }) =>
          Effect.gen(function* () {
            const id = "project:shared:AGENTS.md";
            const opened = yield* catalog.read({ cwd: project, id });
            yield* manager.write({
              cwd: project,
              id,
              contents: "second",
              expectedRevision: opened.revision,
            });
            expect((yield* fs.stat(path.join(project, "AGENTS.md"))).mode & 0o777).toBe(0o600);
          }),
        );
      }),
    );

    it.effect("refuses an unregistered project, a managed file and too much text", () =>
      Effect.gen(function* () {
        const { home, project, fs, path } = yield* makeMachine;
        yield* onMachine(home, { ...CLAUDE, registered: [project] }, ({ manager }) =>
          Effect.gen(function* () {
            const elsewhere = path.join(home, "repos/other");
            yield* fs.makeDirectory(elsewhere, { recursive: true });
            const unregistered = yield* manager
              .write({
                cwd: elsewhere,
                id: "project:shared:AGENTS.md",
                contents: "x",
                expectedRevision: null,
              })
              .pipe(Effect.flip);
            expect(unregistered.reason).toBe("unregisteredProject");
            expect(yield* fs.exists(path.join(elsewhere, "AGENTS.md"))).toBe(false);

            const managed = yield* manager
              .write({ id: "managed:claude", contents: "x", expectedRevision: null })
              .pipe(Effect.flip);
            expect(managed.reason).toBe("readOnly");

            const tooLarge = yield* manager
              .write({
                cwd: project,
                id: "project:shared:AGENTS.md",
                // Over 1 MB in bytes, though not in characters.
                contents: "é".repeat(600_000),
                expectedRevision: null,
              })
              .pipe(Effect.flip);
            expect(tooLarge.reason).toBe("tooLarge");
            expect(yield* fs.exists(path.join(project, "AGENTS.md"))).toBe(false);
          }),
        );
      }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "refuses a subfolder file whose folder leads out of the project, and ids that aren't in the table",
      () =>
        Effect.gen(function* () {
          const { home, project, write, fs, path } = yield* makeMachine;
          yield* write("elsewhere/AGENTS.md", "outside");
          yield* fs.symlink(path.join(home, "elsewhere"), path.join(project, "linked"));
          yield* onMachine(home, { ...CLAUDE, registered: [project] }, ({ manager, catalog }) =>
            Effect.gen(function* () {
              for (const id of [
                "project:nested:linked/AGENTS.md",
                "project:nested:../elsewhere/AGENTS.md",
                "project:nested:linked/../../AGENTS.md",
                "project:shared:../../etc/passwd",
                "global:agentOwn:cursor",
              ]) {
                const error = yield* manager
                  .write({ cwd: project, id, contents: "x", expectedRevision: null })
                  .pipe(Effect.flip);
                expect(error.reason, id).toBe("unknownEntry");
              }
              expect(yield* fs.readFileString(path.join(home, "elsewhere/AGENTS.md"))).toBe(
                "outside",
              );

              // A folder inside the project is fine.
              yield* write("repos/app/apps/web/AGENTS.md", "web");
              const opened = yield* catalog.read({
                cwd: project,
                id: "project:nested:apps/web/AGENTS.md",
              });
              yield* manager.write({
                cwd: project,
                id: "project:nested:apps/web/AGENTS.md",
                contents: "web, edited",
                expectedRevision: opened.revision,
              });
              expect(yield* fs.readFileString(path.join(project, "apps/web/AGENTS.md"))).toBe(
                "web, edited",
              );
            }),
          );
        }),
    );
  });

  describe("turning agents on and off", () => {
    it.effect.skipIf(!symlinksSupported)(
      "gives a link-based agent an absolute link, creating the shared file first",
      () =>
        Effect.gen(function* () {
          const { home, fs, path } = yield* makeMachine;
          yield* onMachine(home, CLAUDE, ({ manager, catalog }) =>
            Effect.gen(function* () {
              const result = yield* manager.enable({
                id: "global:shared",
                agents: agents("codex"),
              });
              yield* encodeAgents(result);

              expect(result.results).toEqual([{ instanceId: "codex", outcome: "changed" }]);
              expect(yield* fs.readLink(path.join(home, ".codex/AGENTS.md"))).toBe(
                path.join(home, ".agents/AGENTS.md"),
              );
              expect(yield* fs.readFileString(path.join(home, ".agents/AGENTS.md"))).toBe("");
              expect(yield* stateOf(catalog, "global:shared")).toMatchObject({
                codex: "link",
                pi: "none",
              });

              const again = yield* manager.enable({ id: "global:shared", agents: agents("codex") });
              expect(again.results).toEqual([{ instanceId: "codex", outcome: "unchanged" }]);
            }),
          );
        }),
    );

    it.effect("gives Claude an import line as the first line and keeps the rest of its file", () =>
      Effect.gen(function* () {
        const { home, write, read } = yield* makeMachine;
        yield* write(".claude/CLAUDE.md", "# My notes\n\nBe brief.\n");
        yield* onMachine(home, CLAUDE, ({ manager, catalog }) =>
          Effect.gen(function* () {
            const result = yield* manager.enable({
              id: "global:shared",
              agents: agents("claudeAgent"),
            });

            expect(result.results).toEqual([{ instanceId: "claudeAgent", outcome: "changed" }]);
            expect(yield* read(".claude/CLAUDE.md")).toBe(
              "@~/.agents/AGENTS.md\n# My notes\n\nBe brief.\n",
            );
            expect(yield* stateOf(catalog, "global:shared")).toMatchObject({
              claudeAgent: "import",
            });
            expect(
              (yield* manager.enable({ id: "global:shared", agents: agents("claudeAgent") }))
                .results,
            ).toEqual([{ instanceId: "claudeAgent", outcome: "unchanged" }]);

            const off = yield* manager.disable({
              id: "global:shared",
              agents: agents("claudeAgent"),
            });
            expect(off.results).toEqual([{ instanceId: "claudeAgent", outcome: "changed" }]);
            expect(yield* read(".claude/CLAUDE.md")).toBe("# My notes\n\nBe brief.\n");
            expect(yield* stateOf(catalog, "global:shared")).toMatchObject({ claudeAgent: "none" });
          }),
        );
      }),
    );

    it.effect("keeps a byte order mark first, through the import line and through an edit", () =>
      Effect.gen(function* () {
        const { home, fs, path, project, write } = yield* makeMachine;
        // `fs.readFileString` drops a mark, so the files are read as bytes.
        const read = (relative: string) =>
          fs
            .readFile(path.join(home, relative))
            .pipe(
              Effect.map((bytes) => new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes)),
            );
        yield* write(".claude/CLAUDE.md", "\uFEFF# My notes\n");
        yield* write("repos/app/AGENTS.md", "\uFEFF# Project\n");
        yield* onMachine(home, { ...CLAUDE, registered: [project] }, ({ manager, catalog }) =>
          Effect.gen(function* () {
            // The mark stays the first character, and the import line goes after it.
            yield* manager.enable({ id: "global:shared", agents: agents("claudeAgent") });
            expect(yield* read(".claude/CLAUDE.md")).toBe(
              "\uFEFF@~/.agents/AGENTS.md\n# My notes\n",
            );
            expect(yield* stateOf(catalog, "global:shared")).toMatchObject({
              claudeAgent: "import",
            });
            expect(
              (yield* manager.enable({ id: "global:shared", agents: agents("claudeAgent") }))
                .results,
            ).toEqual([{ instanceId: "claudeAgent", outcome: "unchanged" }]);
            yield* manager.disable({ id: "global:shared", agents: agents("claudeAgent") });
            expect(yield* read(".claude/CLAUDE.md")).toBe("\uFEFF# My notes\n");

            // The editor gets the text with its mark, and saving it back writes the mark too.
            const opened = yield* catalog.read({ cwd: project, id: "project:shared:AGENTS.md" });
            expect(opened.contents).toBe("\uFEFF# Project\n");
            const saved = yield* manager.write({
              cwd: project,
              id: "project:shared:AGENTS.md",
              contents: `${opened.contents}More.\n`,
              expectedRevision: opened.revision,
            });
            const bytes = yield* fs.readFile(path.join(project, "AGENTS.md"));
            expect(Array.from(bytes.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
            expect(new TextDecoder().decode(bytes.slice(3))).toBe("# Project\nMore.\n");
            // The revision is of the bytes, mark included, so a fresh read agrees with the save.
            expect(
              (yield* catalog.read({ cwd: project, id: "project:shared:AGENTS.md" })).revision,
            ).toBe(saved.revision);
          }),
        );
      }),
    );

    it.effect(
      "makes Claude's file for the import, and removes it again when nothing else is in it",
      () =>
        Effect.gen(function* () {
          const { home, fs, path, read } = yield* makeMachine;
          yield* onMachine(home, CLAUDE, ({ manager }) =>
            Effect.gen(function* () {
              yield* manager.enable({ id: "global:shared", agents: agents("claudeAgent") });
              expect(yield* read(".claude/CLAUDE.md")).toBe("@~/.agents/AGENTS.md\n");

              yield* manager.disable({ id: "global:shared", agents: agents("claudeAgent") });
              expect(yield* fs.exists(path.join(home, ".claude/CLAUDE.md"))).toBe(false);
            }),
          );
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "turns everything on for 'all', and names an agent by its driver kind",
      () =>
        Effect.gen(function* () {
          const { home, fs, path } = yield* makeMachine;
          yield* onMachine(home, CLAUDE, ({ manager, catalog }) =>
            Effect.gen(function* () {
              const result = yield* manager.enable({ id: "global:shared", agents: "all" });
              yield* encodeAgents(result);

              // Cursor and Antigravity have no home file, so they aren't part of it.
              expect(result.results.map((item) => item.instanceId).toSorted()).toEqual([
                "claudeAgent",
                "codex",
                "grok",
                "opencode",
                "pi",
              ]);
              expect(result.results.every((item) => item.outcome === "changed")).toBe(true);
              expect(yield* fs.readLink(path.join(home, ".config/opencode/AGENTS.md"))).toBe(
                path.join(home, ".agents/AGENTS.md"),
              );
              expect(yield* fs.readLink(path.join(home, ".pi/agent/AGENTS.md"))).toBe(
                path.join(home, ".agents/AGENTS.md"),
              );
              expect(Object.values(yield* stateOf(catalog, "global:shared"))).not.toContain("none");

              const off = yield* manager.disable({ id: "global:shared", agents: agents("codex") });
              expect(off.results).toEqual([{ instanceId: "codex", outcome: "changed" }]);
              expect(yield* fs.exists(path.join(home, ".codex/AGENTS.md"))).toBe(false);
              expect(yield* fs.exists(path.join(home, ".agents/AGENTS.md"))).toBe(true);
            }),
          );
        }),
    );

    it.effect("says so for an agent that isn't enabled, and does the rest", () =>
      Effect.gen(function* () {
        const { home, fs, path } = yield* makeMachine;
        yield* onMachine(home, CLAUDE, ({ manager }) =>
          Effect.gen(function* () {
            const result = yield* manager.enable({
              id: "global:shared",
              agents: agents("no-such-agent", "pi"),
            });
            yield* encodeAgents(result);
            expect(result.results).toEqual([
              {
                instanceId: "no-such-agent",
                outcome: "failed",
                reason: "That agent isn't enabled in this environment.",
              },
              { instanceId: "pi", outcome: "changed" },
            ]);
            expect(yield* fs.exists(path.join(home, ".pi/agent/AGENTS.md"))).toBe(true);
          }),
        );
      }),
    );

    it.effect("leaves an agent's own file alone and says to use Global instead first", () =>
      Effect.gen(function* () {
        const { home, write, read } = yield* makeMachine;
        yield* write(".codex/AGENTS.md", "codex notes");
        yield* onMachine(home, CLAUDE, ({ manager }) =>
          Effect.gen(function* () {
            const result = yield* manager.enable({
              id: "global:shared",
              agents: agents("codex"),
            });

            expect(result.results).toEqual([
              {
                instanceId: "codex",
                outcome: "failed",
                reason: "Codex has its own instructions. Use Global instead first.",
              },
            ]);
            expect(yield* read(".codex/AGENTS.md")).toBe("codex notes");
          }),
        );
      }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "never takes something else's place, and doesn't remove a link that isn't the shared one",
      () =>
        Effect.gen(function* () {
          const { home, fs, path } = yield* makeMachine;
          // A dangling link to somewhere else sits where Pi's link would go.
          yield* fs.makeDirectory(path.join(home, ".pi/agent"), { recursive: true });
          yield* fs.symlink(path.join(home, "gone.md"), path.join(home, ".pi/agent/AGENTS.md"));
          yield* onMachine(home, CLAUDE, ({ manager }) =>
            Effect.gen(function* () {
              const result = yield* manager.enable({ id: "global:shared", agents: agents("pi") });

              expect(result.results).toEqual([
                {
                  instanceId: "pi",
                  outcome: "failed",
                  reason: "Something else is already at AGENTS.md.",
                },
              ]);
              expect(yield* fs.readLink(path.join(home, ".pi/agent/AGENTS.md"))).toBe(
                path.join(home, "gone.md"),
              );
              // Disabling an agent that doesn't read the shared file touches nothing.
              expect(
                (yield* manager.disable({ id: "global:shared", agents: agents("pi") })).results,
              ).toEqual([{ instanceId: "pi", outcome: "unchanged" }]);
              expect(yield* fs.readLink(path.join(home, ".pi/agent/AGENTS.md"))).toBe(
                path.join(home, "gone.md"),
              );
            }),
          );
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "doesn't turn off an agent that reads the Global file itself",
      () =>
        Effect.gen(function* () {
          const { home, write, link, read } = yield* makeMachine;
          // Everything links to the Codex file, which is therefore the shared file.
          yield* write(".codex/AGENTS.md", "the rules");
          yield* link(".codex/AGENTS.md", ".claude/CLAUDE.md");
          yield* onMachine(home, CLAUDE, ({ manager, catalog }) =>
            Effect.gen(function* () {
              expect(yield* stateOf(catalog, "global:shared")).toMatchObject({
                codex: "direct",
                claudeAgent: "link",
              });

              const named = yield* manager.disable({
                id: "global:shared",
                agents: agents("codex"),
              });
              expect(named.results).toEqual([
                {
                  instanceId: "codex",
                  outcome: "failed",
                  reason: "Codex reads the Global instructions where they are.",
                },
              ]);
              const all = yield* manager.disable({ id: "global:shared", agents: "all" });
              expect(all.results.find((item) => item.instanceId === "codex")).toMatchObject({
                outcome: "unchanged",
              });
              expect(yield* read(".codex/AGENTS.md")).toBe("the rules");
            }),
          );
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "removes a link Claude joined by, and won't unlink an agent that reads through another agent's file",
      () =>
        Effect.gen(function* () {
          const { home, write, link, fs, path, read } = yield* makeMachine;
          yield* write(".agents/AGENTS.md", "shared");
          yield* link(".agents/AGENTS.md", ".claude/CLAUDE.md");
          yield* onMachine(home, CLAUDE, ({ manager, catalog }) =>
            Effect.gen(function* () {
              expect(yield* stateOf(catalog, "global:shared")).toMatchObject({
                claudeAgent: "link",
                opencode: "link",
              });

              // OpenCode only reads it because Claude's file links to it.
              const opencode = yield* manager.disable({
                id: "global:shared",
                agents: agents("opencode"),
              });
              expect(opencode.results).toEqual([
                {
                  instanceId: "opencode",
                  outcome: "failed",
                  reason: "OpenCode reads the Global instructions through another agent's file.",
                },
              ]);
              expect(yield* fs.exists(path.join(home, ".claude/CLAUDE.md"))).toBe(true);

              const claude = yield* manager.disable({
                id: "global:shared",
                agents: agents("claudeAgent"),
              });
              expect(claude.results).toEqual([{ instanceId: "claudeAgent", outcome: "changed" }]);
              expect(yield* fs.exists(path.join(home, ".claude/CLAUDE.md"))).toBe(false);
              expect(yield* read(".agents/AGENTS.md")).toBe("shared");
            }),
          );
        }),
    );

    it.effect("only turns agents on or off for the shared file", () =>
      Effect.gen(function* () {
        const { home, project } = yield* makeMachine;
        yield* onMachine(home, { ...CLAUDE, registered: [project] }, ({ manager }) =>
          Effect.gen(function* () {
            const error = yield* manager
              .enable({ cwd: project, id: "project:shared:AGENTS.md", agents: "all" })
              .pipe(Effect.flip);
            expect(error.reason).toBe("unknownEntry");
          }),
        );
      }),
    );
  });

  describe("Claude's Project instructions setting", () => {
    const setting = (value: string) => ({
      pluginConfigs: { "cc-plugin-agents-md@builtin": { options: { instructionFiles: value } } },
    });

    it.effect(
      "creates settings.json when it is missing, and nothing when removing from nothing",
      () =>
        Effect.gen(function* () {
          const { home, fs, path, read } = yield* makeMachine;
          yield* onMachine(home, CLAUDE, ({ manager, catalog }) =>
            Effect.gen(function* () {
              yield* manager.setClaudeSetting({ instanceId: agent("claudeAgent"), value: null });
              expect(yield* fs.exists(path.join(home, ".claude/settings.json"))).toBe(false);

              yield* manager.setClaudeSetting({
                instanceId: agent("claudeAgent"),
                value: "claude-md-and-agents-md",
              });
              expect(parseSettingsJson(yield* read(".claude/settings.json"))).toEqual(
                setting("claude-md-and-agents-md"),
              );
              expect((yield* read(".claude/settings.json")).endsWith("}\n")).toBe(true);
              expect((yield* catalog.list({})).claude[0]).toMatchObject({
                value: "claude-md-and-agents-md",
                explicit: true,
              });
            }),
          );
        }),
    );

    it.effect("keeps every other key, updates a legacy entry, and cleans up when reset", () =>
      Effect.gen(function* () {
        const { home, write, read } = yield* makeMachine;
        const other = {
          theme: "dark",
          permissions: { allow: ["Bash(ls)"] },
          pluginConfigs: {
            "some-other@plugin": { options: { keep: true } },
            "agents-md@builtin": { options: { instructionFiles: "claude-md" } },
          },
        };
        yield* write(".claude/settings.json", JSON.stringify(other));
        yield* onMachine(home, CLAUDE, ({ manager }) =>
          Effect.gen(function* () {
            yield* manager.setClaudeSetting({
              instanceId: agent("claudeAgent"),
              value: "claude-md-or-agents-md",
            });
            const set = parseSettingsJson(yield* read(".claude/settings.json"));
            expect(set).toEqual({
              ...other,
              pluginConfigs: {
                "some-other@plugin": { options: { keep: true } },
                "agents-md@builtin": { options: { instructionFiles: "claude-md-or-agents-md" } },
                "cc-plugin-agents-md@builtin": {
                  options: { instructionFiles: "claude-md-or-agents-md" },
                },
              },
            });

            yield* manager.setClaudeSetting({ instanceId: agent("claudeAgent"), value: null });
            expect(parseSettingsJson(yield* read(".claude/settings.json"))).toEqual({
              theme: "dark",
              permissions: { allow: ["Bash(ls)"] },
              pluginConfigs: { "some-other@plugin": { options: { keep: true } } },
            });
          }),
        );
      }),
    );

    it.effect("keeps the comments in a settings.json, as the skill settings do", () =>
      Effect.gen(function* () {
        const { home, write, read } = yield* makeMachine;
        yield* write(".claude/settings.json", '{\n  // my theme\n  "theme": "dark",\n}\n');
        yield* onMachine(home, CLAUDE, ({ manager }) =>
          Effect.gen(function* () {
            yield* manager.setClaudeSetting({
              instanceId: agent("claudeAgent"),
              value: "claude-md",
            });
            const text = yield* read(".claude/settings.json");
            expect(text).toContain("// my theme");
            expect(parseSettingsJson(text)).toEqual({ theme: "dark", ...setting("claude-md") });
          }),
        );
      }),
    );

    it.effect("refuses a settings.json it can't parse and leaves it as it was", () =>
      Effect.gen(function* () {
        const { home, write, read } = yield* makeMachine;
        for (const broken of ["{ not json", "[]", "null", '{"pluginConfigs": "oops"}']) {
          yield* write(".claude/settings.json", broken);
          yield* onMachine(home, CLAUDE, ({ manager }) =>
            Effect.gen(function* () {
              const error = yield* manager
                .setClaudeSetting({ instanceId: agent("claudeAgent"), value: "claude-md" })
                .pipe(Effect.flip);
              expect(error.reason, broken).toBe("invalidSettings");
              expect(yield* read(".claude/settings.json")).toBe(broken);
            }),
          );
        }
      }),
    );

    it.effect("only changes a Claude agent that is enabled", () =>
      Effect.gen(function* () {
        const { home } = yield* makeMachine;
        yield* onMachine(home, CLAUDE, ({ manager }) =>
          Effect.gen(function* () {
            for (const instanceId of ["codex", "nobody"]) {
              const error = yield* manager
                .setClaudeSetting({ instanceId: agent(instanceId), value: "claude-md" })
                .pipe(Effect.flip);
              expect(error.reason).toBe("unknownEntry");
            }
          }),
        );
      }),
    );
  });

  describe("share", () => {
    it.effect(
      "words a refused rename as readOnly and any other failure as writeFailed, with its cause",
      () =>
        Effect.gen(function* () {
          const { home, project, fs, write } = yield* makeMachine;
          yield* write("repos/app/CLAUDE.md", "rules");
          const failingRename = (reason: "PermissionDenied" | "Unknown") =>
            FileSystem.FileSystem.of({
              ...fs,
              rename: (from) =>
                Effect.fail(
                  PlatformError.systemError({
                    _tag: reason,
                    module: "FileSystem",
                    method: "rename",
                    pathOrDescriptor: from,
                    cause: new Error(reason),
                  }),
                ),
            });
          const shareWith = (reason: "PermissionDenied" | "Unknown") =>
            onMachine(home, { ...CLAUDE, registered: [project] }, ({ manager }) =>
              manager
                .share({ cwd: project, id: "project:claude:CLAUDE.md", merge: false })
                .pipe(Effect.flip),
            ).pipe(Effect.provideService(FileSystem.FileSystem, failingRename(reason)));

          const denied = yield* shareWith("PermissionDenied");
          expect(denied.reason).toBe("readOnly");
          expect(denied.message).toBe("T3 Code isn't allowed to change AGENTS.md.");
          expect(denied.cause).toBeInstanceOf(PlatformError.PlatformError);

          const failed = yield* shareWith("Unknown");
          expect(failed.reason).toBe("writeFailed");
          expect(failed.message).toBe("T3 Code couldn't change AGENTS.md.");
          expect(failed.cause).toBeInstanceOf(PlatformError.PlatformError);
          expect(yield* fs.exists(`${project}/CLAUDE.md`)).toBe(true);
        }),
    );

    it.effect("renames CLAUDE.md to AGENTS.md", () =>
      Effect.gen(function* () {
        const { home, project, write, read, fs, path } = yield* makeMachine;
        yield* write("repos/app/CLAUDE.md", "rules");
        yield* onMachine(home, { ...CLAUDE, registered: [project] }, ({ manager }) =>
          Effect.gen(function* () {
            yield* manager.share({ cwd: project, id: "project:claude:CLAUDE.md", merge: false });

            expect(yield* read("repos/app/AGENTS.md")).toBe("rules");
            expect(yield* fs.exists(path.join(project, "CLAUDE.md"))).toBe(false);
          }),
        );
      }),
    );

    it.effect(
      "refuses when AGENTS.md exists, or the project isn't registered, or the file isn't CLAUDE.md",
      () =>
        Effect.gen(function* () {
          const { home, project, write, read } = yield* makeMachine;
          yield* write("repos/app/CLAUDE.md", "claude");
          yield* write("repos/app/AGENTS.md", "agents");
          yield* write("repos/app/.claude/CLAUDE.md", "dot claude");
          yield* onMachine(home, { ...CLAUDE, registered: [project] }, ({ manager }) =>
            Effect.gen(function* () {
              const exists = yield* manager
                .share({ cwd: project, id: "project:claude:CLAUDE.md", merge: false })
                .pipe(Effect.flip);
              expect(exists.reason).toBe("exists");
              expect(yield* read("repos/app/AGENTS.md")).toBe("agents");
              expect(yield* read("repos/app/CLAUDE.md")).toBe("claude");

              const nested = yield* manager
                .share({ cwd: project, id: "project:claude:.claude/CLAUDE.md", merge: false })
                .pipe(Effect.flip);
              expect(nested.reason).toBe("unknownEntry");
            }),
          );
          yield* onMachine(home, { ...CLAUDE, registered: [] }, ({ manager }) =>
            Effect.gen(function* () {
              const unregistered = yield* manager
                .share({ cwd: project, id: "project:claude:CLAUDE.md", merge: false })
                .pipe(Effect.flip);
              expect(unregistered.reason).toBe("unregisteredProject");
            }),
          );
        }),
    );

    it.effect("says when there is no CLAUDE.md to share", () =>
      Effect.gen(function* () {
        const { home, project } = yield* makeMachine;
        yield* onMachine(home, { ...CLAUDE, registered: [project] }, ({ manager }) =>
          Effect.gen(function* () {
            const error = yield* manager
              .share({ cwd: project, id: "project:claude:CLAUDE.md", merge: false })
              .pipe(Effect.flip);
            expect(error.reason).toBe("notFound");
          }),
        );
      }),
    );
  });

  describe("share with merge", () => {
    const CLAUDE_ID = "project:claude:CLAUDE.md";

    it.effect("adds CLAUDE.md's text to the end of AGENTS.md, then deletes CLAUDE.md", () =>
      Effect.gen(function* () {
        const { home, project, write, read, fs, path } = yield* makeMachine;
        yield* write("repos/app/AGENTS.md", "# App\n- Use pnpm.");
        yield* write("repos/app/CLAUDE.md", "\n- Run the tests.\n\n");
        yield* onMachine(home, { ...CLAUDE, registered: [project] }, ({ manager }) =>
          Effect.gen(function* () {
            yield* manager.share({ cwd: project, id: CLAUDE_ID, merge: true });

            expect(yield* read("repos/app/AGENTS.md")).toBe(
              "# App\n- Use pnpm.\n\n- Run the tests.\n",
            );
            expect(yield* fs.exists(path.join(project, "CLAUDE.md"))).toBe(false);
          }),
        );
      }),
    );

    it.effect("takes the line that imports AGENTS.md out of what it adds", () =>
      Effect.gen(function* () {
        const { home, project, write, read } = yield* makeMachine;
        yield* write("repos/app/AGENTS.md", "rules\n");
        yield* write("repos/app/CLAUDE.md", "@AGENTS.md\n\nextra rule\n");
        yield* onMachine(home, { ...CLAUDE, registered: [project] }, ({ manager }) =>
          Effect.gen(function* () {
            yield* manager.share({ cwd: project, id: CLAUDE_ID, merge: true });
            expect(yield* read("repos/app/AGENTS.md")).toBe("rules\n\nextra rule\n");
          }),
        );
      }),
    );

    it.effect(
      "only deletes a CLAUDE.md that is just the import, or that AGENTS.md has already",
      () =>
        Effect.gen(function* () {
          const { home, project, write, read, fs, path } = yield* makeMachine;
          yield* write("repos/app/AGENTS.md", "- Use pnpm.\n- Run the tests.\n");
          yield* onMachine(home, { ...CLAUDE, registered: [project] }, ({ manager }) =>
            Effect.gen(function* () {
              for (const text of ["@./AGENTS.md\n", "- Run the tests.\n", "  \n"]) {
                yield* write("repos/app/CLAUDE.md", text);
                yield* manager.share({ cwd: project, id: CLAUDE_ID, merge: true });

                expect(yield* read("repos/app/AGENTS.md")).toBe("- Use pnpm.\n- Run the tests.\n");
                expect(yield* fs.exists(path.join(project, "CLAUDE.md"))).toBe(false);
              }
            }),
          );
        }),
    );

    it.effect("refuses without an AGENTS.md, and leaves CLAUDE.md alone", () =>
      Effect.gen(function* () {
        const { home, project, write, read } = yield* makeMachine;
        yield* write("repos/app/CLAUDE.md", "rules");
        yield* onMachine(home, { ...CLAUDE, registered: [project] }, ({ manager }) =>
          Effect.gen(function* () {
            const error = yield* manager
              .share({ cwd: project, id: CLAUDE_ID, merge: true })
              .pipe(Effect.flip);
            expect(error.reason).toBe("notFound");
            expect(yield* read("repos/app/CLAUDE.md")).toBe("rules");
          }),
        );
      }),
    );

    it.effect("refuses when the result would be over 1 MB, and changes nothing", () =>
      Effect.gen(function* () {
        const { home, project, write, read } = yield* makeMachine;
        yield* write("repos/app/AGENTS.md", "a".repeat(700_000));
        yield* write("repos/app/CLAUDE.md", "b".repeat(700_000));
        yield* onMachine(home, { ...CLAUDE, registered: [project] }, ({ manager }) =>
          Effect.gen(function* () {
            const error = yield* manager
              .share({ cwd: project, id: CLAUDE_ID, merge: true })
              .pipe(Effect.flip);
            expect(error.reason).toBe("tooLarge");
            expect((yield* read("repos/app/AGENTS.md")).length).toBe(700_000);
            expect((yield* read("repos/app/CLAUDE.md")).length).toBe(700_000);
          }),
        );
      }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "writes through a linked AGENTS.md, and removes a CLAUDE.md that is a link without its target",
      () =>
        Effect.gen(function* () {
          const { home, project, write, link, read, fs, path } = yield* makeMachine;
          yield* write("dotfiles/app-agents.md", "rules\n");
          yield* write("dotfiles/app-claude.md", "more rules\n");
          yield* link("dotfiles/app-agents.md", "repos/app/AGENTS.md");
          yield* link("dotfiles/app-claude.md", "repos/app/CLAUDE.md");
          yield* onMachine(home, { ...CLAUDE, registered: [project] }, ({ manager }) =>
            Effect.gen(function* () {
              yield* manager.share({ cwd: project, id: CLAUDE_ID, merge: true });

              // The text lands in the real file, so AGENTS.md is still a link to it.
              expect(yield* read("dotfiles/app-agents.md")).toBe("rules\n\nmore rules\n");
              expect(yield* fs.readLink(path.join(project, "AGENTS.md"))).toBe(
                path.join(home, "dotfiles/app-agents.md"),
              );
              expect(yield* fs.exists(path.join(project, "CLAUDE.md"))).toBe(false);
              expect(yield* read("dotfiles/app-claude.md")).toBe("more rules\n");
            }),
          );
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "won't delete a CLAUDE.md that the project's AGENTS.md is a link to",
      () =>
        Effect.gen(function* () {
          const { home, project, write, link, read } = yield* makeMachine;
          yield* write("repos/app/CLAUDE.md", "rules");
          yield* link("repos/app/CLAUDE.md", "repos/app/AGENTS.md");
          yield* onMachine(home, { ...CLAUDE, registered: [project] }, ({ manager }) =>
            Effect.gen(function* () {
              const error = yield* manager
                .share({ cwd: project, id: CLAUDE_ID, merge: true })
                .pipe(Effect.flip);
              expect(error.reason).toBe("exists");
              expect(yield* read("repos/app/CLAUDE.md")).toBe("rules");
            }),
          );
        }),
    );
  });

  describe("adopt", () => {
    it.effect.skipIf(!symlinksSupported)(
      "adds the agent's text to the shared file under its name, then links the agent to it",
      () =>
        Effect.gen(function* () {
          const { home, write, read, fs, path } = yield* makeMachine;
          yield* write(".agents/AGENTS.md", "# Shared\n\nBe kind.\n");
          yield* write(".codex/AGENTS.md", "Prefer small diffs.\n");
          yield* onMachine(home, CLAUDE, ({ manager, catalog }) =>
            Effect.gen(function* () {
              yield* manager.adopt({ id: "global:agentOwn:codex" });

              expect(yield* read(".agents/AGENTS.md")).toBe(
                "# Shared\n\nBe kind.\n\n## From Codex\n\nPrefer small diffs.\n",
              );
              expect(yield* fs.readLink(path.join(home, ".codex/AGENTS.md"))).toBe(
                path.join(home, ".agents/AGENTS.md"),
              );
              expect(yield* stateOf(catalog, "global:shared")).toMatchObject({ codex: "link" });
              // The agent's file is the link now, so there is nothing of its own left to move.
              const list = yield* catalog.list({});
              expect(list.entries.map((entry) => entry.id)).toEqual(["global:shared"]);
              yield* manager.adopt({ id: "global:agentOwn:codex" });
              expect(yield* read(".agents/AGENTS.md")).toBe(
                "# Shared\n\nBe kind.\n\n## From Codex\n\nPrefer small diffs.\n",
              );
            }),
          );
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "replaces an agent's link to some other file and leaves that file as it was",
      () =>
        Effect.gen(function* () {
          const { home, write, link, read, fs, path } = yield* makeMachine;
          yield* write(".agents/AGENTS.md", "shared\n");
          yield* write("dotfiles/grok.md", "grok notes\n");
          yield* link("dotfiles/grok.md", ".grok/AGENTS.md");
          // Two different link targets, so neither one is taken for the shared file.
          yield* write("dotfiles/codex.md", "codex notes\n");
          yield* link("dotfiles/codex.md", ".codex/AGENTS.md");
          yield* onMachine(home, CLAUDE, ({ manager }) =>
            Effect.gen(function* () {
              yield* manager.adopt({ id: "global:agentOwn:grok" });

              expect(yield* read(".agents/AGENTS.md")).toBe(
                "shared\n\n## From Grok\n\ngrok notes\n",
              );
              expect(yield* read("dotfiles/grok.md")).toBe("grok notes\n");
              expect(yield* fs.readLink(path.join(home, ".grok/AGENTS.md"))).toBe(
                path.join(home, ".agents/AGENTS.md"),
              );
            }),
          );
        }),
    );

    it.effect.skipIf(!symlinksSupported)("just links an agent whose text is the same", () =>
      Effect.gen(function* () {
        const { home, write, read, fs, path } = yield* makeMachine;
        yield* write(".agents/AGENTS.md", "same\n");
        yield* write(".pi/agent/AGENTS.md", "same");
        yield* onMachine(home, CLAUDE, ({ manager }) =>
          Effect.gen(function* () {
            yield* manager.adopt({ id: "global:agentOwn:pi" });

            expect(yield* read(".agents/AGENTS.md")).toBe("same\n");
            expect(yield* fs.readLink(path.join(home, ".pi/agent/AGENTS.md"))).toBe(
              path.join(home, ".agents/AGENTS.md"),
            );
          }),
        );
      }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "creates the shared file when it doesn't exist, and takes the file Pi really reads",
      () =>
        Effect.gen(function* () {
          const { home, write, read, fs, path } = yield* makeMachine;
          yield* write(".pi/agent/CLAUDE.md", "pi notes");
          yield* onMachine(home, CLAUDE, ({ manager }) =>
            Effect.gen(function* () {
              yield* manager.adopt({ id: "global:agentOwn:pi" });

              expect(yield* read(".agents/AGENTS.md")).toBe("## From Pi\n\npi notes\n");
              // The file Pi reads is the one that became the link.
              expect(yield* fs.readLink(path.join(home, ".pi/agent/CLAUDE.md"))).toBe(
                path.join(home, ".agents/AGENTS.md"),
              );
            }),
          );
        }),
    );

    it.effect(
      "refuses Claude's file, ids that aren't an agent's own file, and an agent with none",
      () =>
        Effect.gen(function* () {
          const { home, write, read } = yield* makeMachine;
          yield* write(".claude/CLAUDE.md", "my claude notes");
          yield* onMachine(home, CLAUDE, ({ manager }) =>
            Effect.gen(function* () {
              for (const [id, reason] of [
                ["global:claude:claudeAgent", "unknownEntry"],
                ["global:shared", "unknownEntry"],
                ["global:agentOwn:cursor", "unknownEntry"],
                ["global:agentOwn:codex", "notFound"],
              ] as const) {
                const error = yield* manager.adopt({ id }).pipe(Effect.flip);
                expect(error.reason, id).toBe(reason);
              }
              expect(yield* read(".claude/CLAUDE.md")).toBe("my claude notes");
            }),
          );
        }),
    );

    it("keeps adopted text exact and doesn't add the same text twice", () => {
      expect(adoptedText("", "Grok", "a\n")).toBe("## From Grok\n\na\n");
      expect(adoptedText("shared", "Grok", "a")).toBe("shared\n\n## From Grok\n\na\n");
      expect(adoptedText("shared\n", "Grok", "a")).toBe("shared\n\n## From Grok\n\na\n");
      expect(adoptedText("x\n\n## From Grok\n\na\n", "Grok", "a")).toBe("x\n\n## From Grok\n\na\n");
      expect(adoptedText("a", "Grok", "a\n")).toBe("a");
      expect(adoptedText("shared", "Grok", " \n")).toBe("shared");
    });
  });

  describe("delete", () => {
    it.effect("removes a real file, and a link without touching what it leads to", () =>
      Effect.gen(function* () {
        const { home, project, write, link, fs, path, read } = yield* makeMachine;
        yield* write("repos/app/CLAUDE.local.md", "mine");
        yield* write(".agents/AGENTS.md", "shared");
        yield* link(".agents/AGENTS.md", "repos/app/CLAUDE.md");
        yield* onMachine(home, { ...CLAUDE, registered: [project] }, ({ manager }) =>
          Effect.gen(function* () {
            yield* manager.delete({ cwd: project, id: "project:claudeLocal:CLAUDE.local.md" });
            expect(yield* fs.exists(path.join(project, "CLAUDE.local.md"))).toBe(false);

            yield* manager.delete({ cwd: project, id: "project:claude:CLAUDE.md" });
            expect(yield* fs.exists(path.join(project, "CLAUDE.md"))).toBe(false);
            expect(yield* read(".agents/AGENTS.md")).toBe("shared");
          }),
        );
      }),
    );

    it.effect(
      "refuses the shared files, a missing file, a managed file and an unregistered project",
      () =>
        Effect.gen(function* () {
          const { home, project, write, read } = yield* makeMachine;
          yield* write("repos/app/AGENTS.md", "project shared");
          yield* write(".agents/AGENTS.md", "global shared");
          yield* onMachine(home, { ...CLAUDE, registered: [project] }, ({ manager }) =>
            Effect.gen(function* () {
              const cases = [
                [{ cwd: project, id: "project:shared:AGENTS.md" }, "readOnly"],
                [{ id: "global:shared" }, "readOnly"],
                [{ cwd: project, id: "project:claude:CLAUDE.md" }, "notFound"],
                [{ id: "managed:claude" }, "readOnly"],
              ] as const;
              for (const [input, reason] of cases) {
                const error = yield* manager.delete(input).pipe(Effect.flip);
                expect(error.reason, input.id).toBe(reason);
              }
              expect(yield* read("repos/app/AGENTS.md")).toBe("project shared");
              expect(yield* read(".agents/AGENTS.md")).toBe("global shared");
            }),
          );
          yield* onMachine(home, { ...CLAUDE, registered: [] }, ({ manager }) =>
            Effect.gen(function* () {
              const error = yield* manager
                .delete({ cwd: project, id: "project:claude:CLAUDE.md" })
                .pipe(Effect.flip);
              expect(error.reason).toBe("unregisteredProject");
            }),
          );
        }),
    );

    it.effect("deletes an agent's own file", () =>
      Effect.gen(function* () {
        const { home, write, fs, path } = yield* makeMachine;
        yield* write(".codex/AGENTS.md", "codex notes");
        yield* onMachine(home, CLAUDE, ({ manager }) =>
          Effect.gen(function* () {
            yield* manager.delete({ id: "global:agentOwn:codex" });
            expect(yield* fs.exists(path.join(home, ".codex/AGENTS.md"))).toBe(false);
          }),
        );
      }),
    );
  });

  describe("tracking", () => {
    it.effect("tells which project instruction files git tracks", () =>
      Effect.gen(function* () {
        const { home, project, write } = yield* makeMachine;
        yield* write("repos/app/AGENTS.md", "tracked");
        yield* write("repos/app/CLAUDE.md", "untracked");
        yield* write("repos/app/apps/web/CLAUDE.md", "nested, tracked");
        const processRunner = yield* ProcessRunner.ProcessRunner;
        const git = (args: ReadonlyArray<string>) =>
          processRunner.run({
            command: "git",
            args: [
              "-C",
              project,
              "-c",
              "user.name=Test",
              "-c",
              "user.email=test@example.com",
              "-c",
              "commit.gpgsign=false",
              ...args,
            ],
          });
        yield* git(["init", "-q"]);
        yield* git(["add", "AGENTS.md", "apps/web/CLAUDE.md"]);
        yield* git(["commit", "-q", "-m", "init"]);

        yield* onMachine(home, CLAUDE, ({ tracking }) =>
          Effect.gen(function* () {
            const result = yield* tracking.tracked({
              cwd: project,
              ids: [
                "project:shared:AGENTS.md",
                "project:claude:CLAUDE.md",
                "project:nested:apps/web/CLAUDE.md",
                "project:nested:apps/missing/AGENTS.md",
                // Not project files, or not in the table.
                "global:shared",
                "project:nested:../AGENTS.md",
              ],
            });
            expect(result.tracked).toEqual([
              "project:shared:AGENTS.md",
              "project:nested:apps/web/CLAUDE.md",
            ]);
          }),
        );
      }).pipe(Effect.provide(ProcessRunner.layer)),
    );

    it.effect("refuses a folder that isn't a registered project, without running git", () =>
      Effect.gen(function* () {
        const { home, project, write } = yield* makeMachine;
        yield* write("repos/app/AGENTS.md", "x");
        yield* onMachine(home, { ...CLAUDE, registered: [] }, ({ tracking }) =>
          Effect.gen(function* () {
            const error = yield* tracking
              .tracked({ cwd: project, ids: ["project:shared:AGENTS.md"] })
              .pipe(Effect.flip);
            expect(error.reason).toBe("unregisteredProject");
          }),
        );
      }),
    );

    it.effect("counts nothing as tracked outside a repository", () =>
      Effect.gen(function* () {
        const { home, project, write } = yield* makeMachine;
        yield* write("repos/app/AGENTS.md", "x");
        yield* onMachine(home, CLAUDE, ({ tracking }) =>
          Effect.gen(function* () {
            expect(
              (yield* tracking.tracked({ cwd: project, ids: ["project:shared:AGENTS.md"] }))
                .tracked,
            ).toEqual([]);
          }),
        );
      }),
    );
  });

  it.effect("names every agent that has a home file", () =>
    Effect.gen(function* () {
      const { home } = yield* makeMachine;
      yield* onMachine(home, CLAUDE, ({ catalog }) =>
        Effect.gen(function* () {
          const view = yield* catalog.shared;
          expect(view.agents.map((reach) => reach.instanceId).toSorted()).toEqual(
            ALL_AGENTS.filter((id) => id !== "cursor" && id !== "antigravity").toSorted(),
          );
          expect(view.agents.find((reach) => reach.instanceId === "claudeAgent")).toMatchObject({
            join: "import",
            joinPath: `${home}/.claude/CLAUDE.md`,
          });
        }),
      );
    }),
  );
});
