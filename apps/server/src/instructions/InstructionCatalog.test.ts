import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  InstructionError,
  InstructionListResult,
  InstructionReadResult,
  ProviderDriverKind,
  ProviderInstanceId,
  type InstructionAgentAccess,
  type InstructionEntry,
} from "@t3tools/contracts";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as InstructionCatalog from "./InstructionCatalog.ts";
import { layerFor, makeMachine, type MachineOptions } from "./testing/machine.ts";

const encodeList = Schema.encodeUnknownEffect(InstructionListResult);
const encodeRead = Schema.encodeUnknownEffect(InstructionReadResult);

/** The catalog on the machine at `home`; every list goes through the RPC schema encode. */
const onMachine = <A, E, R>(
  home: string,
  options: MachineOptions,
  use: (catalog: InstructionCatalog.InstructionCatalog["Service"]) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    return yield* use(yield* InstructionCatalog.InstructionCatalog);
  }).pipe(Effect.provide(layerFor(home, options)));

const listed = (
  catalog: InstructionCatalog.InstructionCatalog["Service"],
  input: { readonly cwd?: string } = {},
) =>
  Effect.gen(function* () {
    const result = yield* catalog.list(input);
    yield* encodeList(result);
    return result;
  });

const entryOf = (entries: readonly InstructionEntry[], id: string) => {
  const entry = entries.find((candidate) => candidate.id === id);
  if (!entry) throw new Error(`No entry ${id} in ${entries.map((e) => e.id).join(", ")}`);
  return entry;
};

/** What each agent does with a file: `state`, plus a reason when it has one. */
const accessOf = (entry: InstructionEntry) =>
  Object.fromEntries(
    entry.access.map((access) => [
      access.instanceId,
      access.reason === undefined ? access.state : `${access.state}:${access.reason}`,
    ]),
  );

const accessFor = (entry: InstructionEntry, instanceId: string): InstructionAgentAccess => {
  const access = entry.access.find((candidate) => candidate.instanceId === instanceId);
  if (!access) throw new Error(`No access for ${instanceId} on ${entry.id}`);
  return access;
};

const CLAUDE = { versions: { claudeAgent: "2.1.291" } } satisfies MachineOptions;

it.layer(NodeServices.layer, { excludeTestServices: true })("InstructionCatalog", (it) => {
  describe("project files", () => {
    it.effect(
      "lists a missing AGENTS.md and CLAUDE.local.md so they can be created, and no other",
      () =>
        Effect.gen(function* () {
          const { home, project } = yield* makeMachine;
          yield* onMachine(home, CLAUDE, (catalog) =>
            Effect.gen(function* () {
              const { entries } = yield* listed(catalog, { cwd: project });
              const projectEntries = entries.filter((entry) => entry.scope === "project");

              expect(projectEntries.map((entry) => entry.id)).toEqual([
                "project:shared:AGENTS.md",
                "project:claudeLocal:CLAUDE.local.md",
              ]);
              expect(accessFor(projectEntries[1]!, "claudeAgent").state).toBe("direct");
              expect(projectEntries[0]).toMatchObject({
                kind: "shared",
                exists: false,
                size: 0,
                readOnly: false,
                path: `${project}/AGENTS.md`,
                relativePath: "AGENTS.md",
              });
            }),
          );
        }),
    );

    it.effect("reads no project files without a project", () =>
      Effect.gen(function* () {
        const { home, write } = yield* makeMachine;
        yield* write("repos/app/AGENTS.md", "rules");
        yield* onMachine(home, CLAUDE, (catalog) =>
          Effect.gen(function* () {
            const { entries } = yield* listed(catalog);
            expect(entries.some((entry) => entry.scope === "project")).toBe(false);
          }),
        );
      }),
    );

    it.effect("tells which agents read a CLAUDE.md that has no AGENTS.md next to it", () =>
      Effect.gen(function* () {
        const { home, project, write } = yield* makeMachine;
        yield* write("repos/app/CLAUDE.md", "claude rules");
        yield* onMachine(home, CLAUDE, (catalog) =>
          Effect.gen(function* () {
            const { entries } = yield* listed(catalog, { cwd: project });
            const claudeMd = entryOf(entries, "project:claude:CLAUDE.md");

            expect(claudeMd).toMatchObject({ exists: true, size: 12, kind: "claude" });
            expect(accessOf(claudeMd)).toEqual({
              claudeAgent: "direct",
              codex: "none",
              cursor: "none",
              grok: "direct",
              // OpenCode and Pi fall back to CLAUDE.md only because nothing named AGENTS.md exists.
              opencode: "direct",
              antigravity: "none",
              pi: "direct",
            });
          }),
        );
      }),
    );

    it.effect("stops Pi and OpenCode reading CLAUDE.md once AGENTS.md exists", () =>
      Effect.gen(function* () {
        const { home, project, write } = yield* makeMachine;
        yield* write("repos/app/CLAUDE.md", "claude rules");
        yield* write("repos/app/AGENTS.md", "shared rules");
        yield* onMachine(home, CLAUDE, (catalog) =>
          Effect.gen(function* () {
            const { entries } = yield* listed(catalog, { cwd: project });
            const claudeMd = entryOf(entries, "project:claude:CLAUDE.md");
            const agentsMd = entryOf(entries, "project:shared:AGENTS.md");

            expect(accessFor(claudeMd, "pi")).toMatchObject({
              state: "none",
              blockingFile: "AGENTS.md",
            });
            expect(accessFor(claudeMd, "opencode")).toMatchObject({
              state: "none",
              blockingFile: "AGENTS.md",
            });
            expect(accessFor(claudeMd, "claudeAgent").state).toBe("direct");
            expect(accessFor(claudeMd, "grok").state).toBe("direct");
            // Everyone but Claude reads AGENTS.md; Claude's own CLAUDE.md wins by default.
            expect(accessOf(agentsMd)).toEqual({
              claudeAgent: "none:claudeFiles",
              codex: "direct",
              cursor: "direct",
              grok: "direct",
              opencode: "direct",
              antigravity: "direct",
              pi: "direct",
            });
            expect(accessFor(agentsMd, "claudeAgent").blockingFile).toBe("CLAUDE.md");
          }),
        );
      }),
    );

    it.effect("makes Codex and Pi prefer AGENTS.override.md", () =>
      Effect.gen(function* () {
        const { home, project, write } = yield* makeMachine;
        yield* write("repos/app/AGENTS.md", "shared rules");
        yield* write("repos/app/AGENTS.override.md", "override");
        yield* onMachine(home, CLAUDE, (catalog) =>
          Effect.gen(function* () {
            const { entries } = yield* listed(catalog, { cwd: project });
            const agentsMd = entryOf(entries, "project:shared:AGENTS.md");

            for (const blocked of ["codex", "pi"]) {
              expect(accessFor(agentsMd, blocked)).toMatchObject({
                state: "none",
                blockingFile: "AGENTS.override.md",
              });
            }
            expect(accessFor(agentsMd, "opencode").state).toBe("direct");
          }),
        );
      }),
    );

    it.effect("doesn't credit Grok with CLAUDE.local.md, which it skips when git ignores it", () =>
      Effect.gen(function* () {
        const { home, project, write } = yield* makeMachine;
        yield* write("repos/app/CLAUDE.local.md", "mine");
        yield* onMachine(home, CLAUDE, (catalog) =>
          Effect.gen(function* () {
            const { entries } = yield* listed(catalog, { cwd: project });
            const local = entryOf(entries, "project:claudeLocal:CLAUDE.local.md");

            expect(local.kind).toBe("claudeLocal");
            expect(accessFor(local, "claudeAgent").state).toBe("direct");
            expect(accessFor(local, "grok").state).toBe("none");
          }),
        );
      }),
    );

    it.effect("switches OpenCode's CLAUDE.md fallback off with its environment variable", () =>
      Effect.gen(function* () {
        const { home, project, write } = yield* makeMachine;
        yield* write("repos/app/CLAUDE.md", "claude rules");
        yield* onMachine(
          home,
          {
            ...CLAUDE,
            providerInstances: {
              [ProviderInstanceId.make("opencode")]: {
                driver: ProviderDriverKind.make("opencode"),
                enabled: true,
                environment: [
                  { name: "OPENCODE_DISABLE_CLAUDE_CODE", value: "1", sensitive: false },
                ],
              },
            },
          },
          (catalog) =>
            Effect.gen(function* () {
              const { entries } = yield* listed(catalog, { cwd: project });
              expect(
                accessFor(entryOf(entries, "project:claude:CLAUDE.md"), "opencode").state,
              ).toBe("none");
            }),
        );
      }),
    );
  });

  describe("Claude and a project's AGENTS.md", () => {
    const claudeAccess = (entries: readonly InstructionEntry[]) =>
      accessFor(entryOf(entries, "project:shared:AGENTS.md"), "claudeAgent");

    it.effect("is blocked by CLAUDE.local.md and names it", () =>
      Effect.gen(function* () {
        const { home, project, write } = yield* makeMachine;
        yield* write("repos/app/AGENTS.md", "rules");
        yield* write("repos/app/CLAUDE.local.md", "mine");
        yield* onMachine(home, CLAUDE, (catalog) =>
          Effect.gen(function* () {
            const { entries, claude } = yield* listed(catalog, { cwd: project });

            expect(claudeAccess(entries)).toEqual({
              instanceId: "claudeAgent",
              driver: "claudeAgent",
              state: "none",
              reason: "claudeFiles",
              blockingFile: "CLAUDE.local.md",
            });
            expect(claude).toEqual([
              {
                instanceId: "claudeAgent",
                value: "claude-md-or-agents-md",
                explicit: false,
                supported: true,
                version: "2.1.291",
              },
            ]);
          }),
        );
      }),
    );

    it.effect("reads it through the setting when no CLAUDE file stands in the way", () =>
      Effect.gen(function* () {
        const { home, project, write } = yield* makeMachine;
        yield* write("repos/app/AGENTS.md", "rules");
        yield* onMachine(home, CLAUDE, (catalog) =>
          Effect.gen(function* () {
            const { entries } = yield* listed(catalog, { cwd: project });
            expect(claudeAccess(entries)).toMatchObject({ state: "setting" });
            expect(claudeAccess(entries).reason).toBeUndefined();
          }),
        );
      }),
    );

    it.effect("reads both files when the setting says so, and none when it says never", () =>
      Effect.gen(function* () {
        const { home, project, write } = yield* makeMachine;
        yield* write("repos/app/AGENTS.md", "rules");
        yield* write("repos/app/CLAUDE.md", "claude rules");
        yield* write(
          ".claude/settings.json",
          JSON.stringify({
            pluginConfigs: {
              "cc-plugin-agents-md@builtin": {
                options: { instructionFiles: "claude-md-and-agents-md" },
              },
            },
          }),
        );
        yield* onMachine(home, CLAUDE, (catalog) =>
          Effect.gen(function* () {
            const both = yield* listed(catalog, { cwd: project });
            expect(claudeAccess(both.entries)).toMatchObject({ state: "setting" });
            expect(both.claude[0]).toMatchObject({
              value: "claude-md-and-agents-md",
              explicit: true,
            });
          }),
        );
        // The legacy plugin id counts too.
        yield* write(
          ".claude/settings.json",
          JSON.stringify({
            pluginConfigs: { "agents-md@builtin": { options: { instructionFiles: "claude-md" } } },
          }),
        );
        yield* onMachine(home, CLAUDE, (catalog) =>
          Effect.gen(function* () {
            const never = yield* listed(catalog, { cwd: project });
            expect(claudeAccess(never.entries)).toMatchObject({
              state: "none",
              reason: "settingOff",
            });
            expect(never.claude[0]).toMatchObject({ value: "claude-md", explicit: true });
          }),
        );
      }),
    );

    it.effect(
      "reads it through a CLAUDE.md that imports it, unless the setting is managed-only",
      () =>
        Effect.gen(function* () {
          const { home, project, write } = yield* makeMachine;
          yield* write("repos/app/AGENTS.md", "rules");
          yield* write("repos/app/CLAUDE.md", "@AGENTS.md\nmore");
          yield* onMachine(home, CLAUDE, (catalog) =>
            Effect.gen(function* () {
              const { entries } = yield* listed(catalog, { cwd: project });
              expect(claudeAccess(entries)).toMatchObject({ state: "import" });
            }),
          );
          yield* write(
            ".claude/settings.json",
            JSON.stringify({
              pluginConfigs: {
                "cc-plugin-agents-md@builtin": { options: { instructionFiles: "managed-only" } },
              },
            }),
          );
          yield* onMachine(home, CLAUDE, (catalog) =>
            Effect.gen(function* () {
              const { entries } = yield* listed(catalog, { cwd: project });
              expect(claudeAccess(entries)).toMatchObject({ state: "none", reason: "settingOff" });
            }),
          );
        }),
    );

    it.effect(
      "can't read it on a Claude Code version before 2.1.277, or with no version known",
      () =>
        Effect.gen(function* () {
          const { home, project, write } = yield* makeMachine;
          yield* write("repos/app/AGENTS.md", "rules");
          for (const versions of [{ claudeAgent: "2.1.200" }, {}]) {
            yield* onMachine(home, { versions }, (catalog) =>
              Effect.gen(function* () {
                const { entries, claude } = yield* listed(catalog, { cwd: project });
                expect(claudeAccess(entries)).toMatchObject({
                  state: "none",
                  reason: "oldVersion",
                });
                expect(claude[0]).toMatchObject({ supported: false });
              }),
            );
          }
        }),
    );

    it.effect("keeps an import working on an old version", () =>
      Effect.gen(function* () {
        const { home, project, write } = yield* makeMachine;
        yield* write("repos/app/AGENTS.md", "rules");
        yield* write("repos/app/CLAUDE.md", "@AGENTS.md");
        yield* onMachine(home, { versions: { claudeAgent: "2.0.0" } }, (catalog) =>
          Effect.gen(function* () {
            const { entries } = yield* listed(catalog, { cwd: project });
            expect(claudeAccess(entries)).toMatchObject({ state: "import" });
          }),
        );
      }),
    );

    it.effect(
      "gives a CLAUDE.md that only imports AGENTS.md no entry, and keeps the import working",
      () =>
        Effect.gen(function* () {
          const { home, project, write } = yield* makeMachine;
          yield* write("repos/app/AGENTS.md", "rules");
          for (const only of ["@AGENTS.md\n", "\n@./AGENTS.md\n\n"]) {
            yield* write("repos/app/CLAUDE.md", only);
            yield* onMachine(home, CLAUDE, (catalog) =>
              Effect.gen(function* () {
                const { entries } = yield* listed(catalog, { cwd: project });
                expect(entries.map((entry) => entry.id)).not.toContain("project:claude:CLAUDE.md");
                expect(claudeAccess(entries)).toMatchObject({ state: "import" });
              }),
            );
          }
          // Anything else in the file keeps its entry, and so does an empty one.
          for (const text of ["@AGENTS.md\n- Run the tests.\n", ""]) {
            yield* write("repos/app/CLAUDE.md", text);
            yield* onMachine(home, CLAUDE, (catalog) =>
              Effect.gen(function* () {
                const { entries } = yield* listed(catalog, { cwd: project });
                expect(entries.map((entry) => entry.id)).toContain("project:claude:CLAUDE.md");
              }),
            );
          }
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "gives a CLAUDE.md that is the same file as AGENTS.md no entry, whichever links to the other",
      () =>
        Effect.gen(function* () {
          const { home, fs, path, project, write, link } = yield* makeMachine;
          for (const [real, linked] of [
            ["AGENTS.md", "CLAUDE.md"],
            ["CLAUDE.md", "AGENTS.md"],
          ] as const) {
            yield* fs.remove(path.join(project, "AGENTS.md"), { force: true });
            yield* fs.remove(path.join(project, "CLAUDE.md"), { force: true });
            yield* write(`repos/app/${real}`, "rules");
            yield* link(`repos/app/${real}`, `repos/app/${linked}`);
            yield* onMachine(home, CLAUDE, (catalog) =>
              Effect.gen(function* () {
                const { entries } = yield* listed(catalog, { cwd: project });
                expect(entries.map((entry) => entry.id)).not.toContain("project:claude:CLAUDE.md");
                expect(claudeAccess(entries)).toMatchObject({ state: "import" });
              }),
            );
          }
        }),
    );

    it.effect("reads a settings.json and an AGENTS.md that start with a byte order mark", () =>
      Effect.gen(function* () {
        const { home, project, write } = yield* makeMachine;
        yield* write(
          ".claude/settings.json",
          `\uFEFF${JSON.stringify({
            pluginConfigs: {
              "cc-plugin-agents-md@builtin": { options: { instructionFiles: "claude-md" } },
            },
          })}`,
        );
        yield* write("repos/app/AGENTS.md", "\uFEFFrules");
        yield* onMachine(home, CLAUDE, (catalog) =>
          Effect.gen(function* () {
            const { claude, unreadable } = yield* listed(catalog, { cwd: project });
            expect(claude[0]).toMatchObject({ value: "claude-md", explicit: true });
            expect(unreadable).toEqual([]);
            // The text is the file's, mark included, and its size is the file's bytes.
            const read = yield* catalog.read({ cwd: project, id: "project:shared:AGENTS.md" });
            expect(read.contents).toBe("\uFEFFrules");
            expect(
              (yield* listed(catalog, { cwd: project })).entries.find(
                (entry) => entry.id === "project:shared:AGENTS.md",
              ),
            ).toMatchObject({ exists: true, size: 8 });
          }),
        );
      }),
    );

    it.effect("reports a settings.json that isn't JSON and falls back to Claude's default", () =>
      Effect.gen(function* () {
        const { home, project, write } = yield* makeMachine;
        yield* write(".claude/settings.json", "{ not json");
        yield* onMachine(home, CLAUDE, (catalog) =>
          Effect.gen(function* () {
            const { claude, unreadable } = yield* listed(catalog, { cwd: project });
            expect(claude[0]).toMatchObject({ value: "claude-md-or-agents-md", explicit: false });
            expect(unreadable).toEqual([
              { path: `${home}/.claude/settings.json`, reason: "It isn't valid JSON." },
            ]);
          }),
        );
      }),
    );
  });

  describe("files in subfolders", () => {
    it.effect("comes from the file index, without the top folder's own files or dependencies", () =>
      Effect.gen(function* () {
        const { home, project, write } = yield* makeMachine;
        yield* write("repos/app/AGENTS.md", "root");
        yield* write("repos/app/.claude/CLAUDE.md", "root claude");
        yield* write("repos/app/apps/web/AGENTS.md", "web");
        yield* write("repos/app/packages/ui/CLAUDE.md", "ui");
        yield* write("repos/app/node_modules/dep/AGENTS.md", "dependency");
        yield* write("repos/app/apps/web/README.md", "not an instruction file");
        yield* onMachine(home, CLAUDE, (catalog) =>
          Effect.gen(function* () {
            const { entries } = yield* listed(catalog, { cwd: project });
            const nested = entries.filter((entry) => entry.kind === "nested");

            expect(nested.map((entry) => entry.id)).toEqual([
              "project:nested:apps/web/AGENTS.md",
              "project:nested:packages/ui/CLAUDE.md",
            ]);
            expect(nested[0]).toMatchObject({
              scope: "project",
              relativePath: "apps/web/AGENTS.md",
              exists: true,
              size: 3,
              readOnly: false,
              access: [],
            });
            // The top folder's own `.claude/CLAUDE.md` has its own entry.
            expect(entries.map((entry) => entry.id)).toContain("project:claude:.claude/CLAUDE.md");
          }),
        );
      }),
    );

    it.effect("caps them at 50", () =>
      Effect.gen(function* () {
        const { home, project, write } = yield* makeMachine;
        for (let index = 0; index < 60; index += 1) {
          yield* write(`repos/app/packages/p${String(index).padStart(2, "0")}/AGENTS.md`, "x");
        }
        yield* onMachine(home, CLAUDE, (catalog) =>
          Effect.gen(function* () {
            const { entries } = yield* listed(catalog, { cwd: project });
            expect(entries.filter((entry) => entry.kind === "nested")).toHaveLength(50);
          }),
        );
      }),
    );
  });

  describe("the shared file for all projects", () => {
    it.effect(
      "is ~/.agents/AGENTS.md when nothing links anywhere, and listed even if missing",
      () =>
        Effect.gen(function* () {
          const { home } = yield* makeMachine;
          yield* onMachine(home, CLAUDE, (catalog) =>
            Effect.gen(function* () {
              const result = yield* listed(catalog);
              const shared = entryOf(result.entries, "global:shared");

              expect(result.sharedPath).toBe(`${home}/.agents/AGENTS.md`);
              expect(shared).toMatchObject({
                scope: "global",
                kind: "shared",
                path: `${home}/.agents/AGENTS.md`,
                exists: false,
                size: 0,
              });
              // Cursor and Antigravity have no home file, so they have nothing to say about it.
              expect(Object.keys(accessOf(shared)).toSorted()).toEqual([
                "claudeAgent",
                "codex",
                "grok",
                "opencode",
                "pi",
              ]);
              expect(Object.values(accessOf(shared)).every((state) => state === "none")).toBe(true);
            }),
          );
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "keeps the one real file the agents' home files already link to",
      () =>
        Effect.gen(function* () {
          const { home, write, link } = yield* makeMachine;
          yield* write("library/everything.md", "all my rules");
          yield* link("library/everything.md", ".claude/CLAUDE.md");
          yield* link("library/everything.md", ".codex/AGENTS.md");
          yield* onMachine(home, CLAUDE, (catalog) =>
            Effect.gen(function* () {
              const result = yield* listed(catalog);
              const shared = entryOf(result.entries, "global:shared");

              expect(result.sharedPath).toBe(`${home}/library/everything.md`);
              expect(shared).toMatchObject({ exists: true, size: 12 });
              // OpenCode and Grok read ~/.claude/CLAUDE.md as well, which is one of the links.
              expect(accessOf(shared)).toEqual({
                claudeAgent: "link",
                codex: "link",
                grok: "link",
                opencode: "link",
                pi: "none",
              });
              // Claude's home file is the link, so there is no row of its own for it.
              expect(result.entries.map((entry) => entry.id)).toEqual(["global:shared"]);
            }),
          );
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "falls back to the default when the links lead to different files",
      () =>
        Effect.gen(function* () {
          const { home, write, link } = yield* makeMachine;
          yield* write("library/one.md", "one");
          yield* write("library/two.md", "two");
          yield* link("library/one.md", ".claude/CLAUDE.md");
          yield* link("library/two.md", ".codex/AGENTS.md");
          yield* onMachine(home, CLAUDE, (catalog) =>
            Effect.gen(function* () {
              expect((yield* listed(catalog)).sharedPath).toBe(`${home}/.agents/AGENTS.md`);
            }),
          );
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "sees Claude's import line, and a link that leads to the shared file before it exists",
      () =>
        Effect.gen(function* () {
          const { home, path, write, fs } = yield* makeMachine;
          yield* write(".claude/CLAUDE.md", "@~/.agents/AGENTS.md\n\nmy own notes\n");
          yield* fs.makeDirectory(path.join(home, ".codex"), { recursive: true });
          yield* fs.symlink(`${home}/.agents/AGENTS.md`, path.join(home, ".codex/AGENTS.md"));
          yield* onMachine(home, CLAUDE, (catalog) =>
            Effect.gen(function* () {
              const result = yield* listed(catalog);
              const shared = entryOf(result.entries, "global:shared");

              expect(shared.exists).toBe(false);
              expect(accessOf(shared)).toMatchObject({ claudeAgent: "import", codex: "link" });
              // The notes next to the import line are worth a row of their own.
              expect(entryOf(result.entries, "global:claude:claudeAgent")).toMatchObject({
                kind: "claude",
                owner: "claudeAgent",
                sameAsShared: false,
                path: `${home}/.claude/CLAUDE.md`,
              });
            }),
          );
        }),
    );

    it.effect("gives Claude no row of its own when its file is only the import line", () =>
      Effect.gen(function* () {
        const { home, write } = yield* makeMachine;
        yield* write(".claude/CLAUDE.md", "@~/.agents/AGENTS.md\n");
        yield* onMachine(home, CLAUDE, (catalog) =>
          Effect.gen(function* () {
            const result = yield* listed(catalog);
            expect(accessOf(entryOf(result.entries, "global:shared")).claudeAgent).toBe("import");
            expect(result.entries.map((entry) => entry.id)).toEqual(["global:shared"]);
          }),
        );
      }),
    );
  });

  describe("an agent's own home file", () => {
    it.effect.skipIf(!symlinksSupported)(
      "stops the agent joining the shared file when it holds different text",
      () =>
        Effect.gen(function* () {
          const { home, write } = yield* makeMachine;
          yield* write(".agents/AGENTS.md", "shared");
          yield* write(".codex/AGENTS.md", "codex notes");
          yield* onMachine(home, CLAUDE, (catalog) =>
            Effect.gen(function* () {
              const result = yield* listed(catalog);

              expect(accessFor(entryOf(result.entries, "global:shared"), "codex")).toEqual({
                instanceId: "codex",
                driver: "codex",
                state: "none",
                reason: "ownFile",
              });
              expect(entryOf(result.entries, "global:agentOwn:codex")).toMatchObject({
                kind: "agentOwn",
                owner: "codex",
                path: `${home}/.codex/AGENTS.md`,
                sameAsShared: false,
              });
              expect(accessOf(entryOf(result.entries, "global:agentOwn:codex"))).toMatchObject({
                codex: "direct",
                pi: "none",
              });
            }),
          );
        }),
    );

    it.effect("notes when the agent's file has the same text as the shared one", () =>
      Effect.gen(function* () {
        const { home, write } = yield* makeMachine;
        yield* write(".agents/AGENTS.md", "same text\n");
        yield* write(".codex/AGENTS.md", "same text");
        yield* onMachine(home, CLAUDE, (catalog) =>
          Effect.gen(function* () {
            const { entries } = yield* listed(catalog);
            expect(entryOf(entries, "global:agentOwn:codex").sameAsShared).toBe(true);
          }),
        );
      }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "makes a Codex override file win over a link, and names it",
      () =>
        Effect.gen(function* () {
          const { home, path, write, fs } = yield* makeMachine;
          yield* write(".agents/AGENTS.md", "shared");
          yield* write(".codex/AGENTS.override.md", "override");
          yield* fs.symlink(`${home}/.agents/AGENTS.md`, path.join(home, ".codex/AGENTS.md"));
          yield* onMachine(home, CLAUDE, (catalog) =>
            Effect.gen(function* () {
              const { entries } = yield* listed(catalog);

              expect(accessFor(entryOf(entries, "global:shared"), "codex")).toMatchObject({
                state: "none",
                reason: "ownFile",
                blockingFile: "AGENTS.override.md",
              });
              expect(entryOf(entries, "global:agentOwn:codex").path).toBe(
                `${home}/.codex/AGENTS.override.md`,
              );
            }),
          );
        }),
    );

    it.effect("passes over an empty Codex override file, as Codex does", () =>
      Effect.gen(function* () {
        const { home, write } = yield* makeMachine;
        yield* write(".codex/AGENTS.override.md", "");
        yield* write(".codex/AGENTS.md", "codex notes");
        yield* onMachine(home, CLAUDE, (catalog) =>
          Effect.gen(function* () {
            const { entries } = yield* listed(catalog);
            expect(entryOf(entries, "global:agentOwn:codex").path).toBe(`${home}/.codex/AGENTS.md`);
          }),
        );
      }),
    );

    it.effect("takes Pi's CLAUDE.md as its own file when it has no AGENTS.md", () =>
      Effect.gen(function* () {
        const { home, write } = yield* makeMachine;
        yield* write(".pi/agent/CLAUDE.md", "pi notes");
        yield* onMachine(home, CLAUDE, (catalog) =>
          Effect.gen(function* () {
            const { entries } = yield* listed(catalog);
            expect(accessFor(entryOf(entries, "global:shared"), "pi")).toMatchObject({
              state: "none",
              reason: "ownFile",
              blockingFile: "CLAUDE.md",
            });
            expect(entryOf(entries, "global:agentOwn:pi").path).toBe(`${home}/.pi/agent/CLAUDE.md`);
          }),
        );
      }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "lets OpenCode and Grok reach the shared file through ~/.claude/CLAUDE.md",
      () =>
        Effect.gen(function* () {
          const { home, write, link } = yield* makeMachine;
          yield* write(".agents/AGENTS.md", "shared");
          yield* link(".agents/AGENTS.md", ".claude/CLAUDE.md");
          yield* onMachine(home, CLAUDE, (catalog) =>
            Effect.gen(function* () {
              const { entries } = yield* listed(catalog);
              expect(accessOf(entryOf(entries, "global:shared"))).toEqual({
                claudeAgent: "link",
                codex: "none",
                grok: "link",
                opencode: "link",
                pi: "none",
              });
            }),
          );
          // OpenCode only falls back when it has no file of its own.
          yield* write(".config/opencode/AGENTS.md", "opencode notes");
          yield* onMachine(home, CLAUDE, (catalog) =>
            Effect.gen(function* () {
              const { entries } = yield* listed(catalog);
              expect(accessFor(entryOf(entries, "global:shared"), "opencode")).toMatchObject({
                state: "none",
                reason: "ownFile",
              });
            }),
          );
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "follows each instance's own home folder, not just the default",
      () =>
        Effect.gen(function* () {
          const { home, write, link } = yield* makeMachine;
          yield* write(".agents/AGENTS.md", "shared");
          yield* write("work-claude/CLAUDE.md", "@~/.agents/AGENTS.md\nnotes");
          yield* link(".agents/AGENTS.md", "codex-work/AGENTS.md");
          yield* onMachine(
            home,
            {
              versions: { claude_work: "2.1.291" },
              providerInstances: {
                [ProviderInstanceId.make("claudeAgent")]: {
                  driver: ProviderDriverKind.make("claudeAgent"),
                  enabled: false,
                },
                [ProviderInstanceId.make("claude_work")]: {
                  driver: ProviderDriverKind.make("claudeAgent"),
                  config: { homePath: `${home}/work-claude` },
                },
                [ProviderInstanceId.make("codex")]: {
                  driver: ProviderDriverKind.make("codex"),
                  environment: [
                    { name: "CODEX_HOME", value: `${home}/codex-work`, sensitive: false },
                  ],
                },
              },
            },
            (catalog) =>
              Effect.gen(function* () {
                const { entries, claude } = yield* listed(catalog);

                expect(accessOf(entryOf(entries, "global:shared"))).toMatchObject({
                  claude_work: "import",
                  codex: "link",
                });
                expect(claude.map((choice) => choice.instanceId)).toEqual(["claude_work"]);
                expect(entryOf(entries, "global:claude:claude_work").path).toBe(
                  `${home}/work-claude/CLAUDE.md`,
                );
              }),
          );
        }),
    );
  });

  describe("read", () => {
    it.effect("returns the text and a revision, through a link too", () =>
      Effect.gen(function* () {
        const { home, project, write, link } = yield* makeMachine;
        yield* write(".agents/AGENTS.md", "shared text");
        yield* write("repos/app/AGENTS.md", "project text");
        yield* link(".agents/AGENTS.md", "repos/app/CLAUDE.md");
        yield* onMachine(home, CLAUDE, (catalog) =>
          Effect.gen(function* () {
            const global = yield* catalog.read({ id: "global:shared" });
            const viaLink = yield* catalog.read({ cwd: project, id: "project:claude:CLAUDE.md" });
            yield* encodeRead(global);

            expect(global).toMatchObject({
              id: "global:shared",
              contents: "shared text",
              tooLarge: false,
            });
            expect(global.revision).toMatch(/^[0-9a-f]{64}$/);
            expect(viaLink.contents).toBe("shared text");
            expect(viaLink.revision).toBe(global.revision);
          }),
        );
      }),
    );

    it.effect("says nothing for a missing file, and when a file is over 1 MB", () =>
      Effect.gen(function* () {
        const { home, project, write } = yield* makeMachine;
        yield* write("repos/app/CLAUDE.md", "x".repeat(1_048_577));
        yield* onMachine(home, CLAUDE, (catalog) =>
          Effect.gen(function* () {
            expect(yield* catalog.read({ cwd: project, id: "project:shared:AGENTS.md" })).toEqual({
              id: "project:shared:AGENTS.md",
              contents: null,
              revision: null,
              tooLarge: false,
            });
            expect(yield* catalog.read({ cwd: project, id: "project:claude:CLAUDE.md" })).toEqual({
              id: "project:claude:CLAUDE.md",
              contents: null,
              revision: null,
              tooLarge: true,
            });
          }),
        );
      }),
    );

    it.effect("reads under a folder only when it is a registered project's workspace root", () =>
      Effect.gen(function* () {
        const { home, project, write } = yield* makeMachine;
        yield* write(".agents/AGENTS.md", "shared text");
        yield* write("repos/app/AGENTS.md", "project text");
        yield* write("elsewhere/AGENTS.md", "not a project's");
        yield* onMachine(home, CLAUDE, (catalog) =>
          Effect.gen(function* () {
            const refusal = (cwd: string, id: string) =>
              catalog.read({ cwd, id }).pipe(
                Effect.flip,
                Effect.map((error) => [error._tag, error.reason]),
              );
            const unregistered = ["unregisteredProject"];

            // A folder above the project, one beside it, and a relative one reach no file under
            // them, even by an id the table builds.
            expect(yield* refusal(home, "project:nested:elsewhere/AGENTS.md")).toEqual([
              "InstructionError",
              ...unregistered,
            ]);
            expect(yield* refusal(`${home}/elsewhere`, "project:shared:AGENTS.md")).toEqual([
              "InstructionError",
              ...unregistered,
            ]);
            expect(yield* refusal("repos/app", "project:shared:AGENTS.md")).toEqual([
              "InstructionError",
              ...unregistered,
            ]);
            expect(
              yield* catalog.list({ cwd: home }).pipe(
                Effect.flip,
                Effect.map((error) => error.reason),
              ),
            ).toBe("unregisteredProject");
            expect(
              yield* catalog.resolve({ cwd: home, id: "project:shared:AGENTS.md" }).pipe(
                Effect.flip,
                Effect.map((error) => error.reason),
              ),
            ).toBe("unregisteredProject");

            // The registered folder, and the home files without any folder, read as before.
            expect(
              (yield* catalog.read({ cwd: project, id: "project:shared:AGENTS.md" })).contents,
            ).toBe("project text");
            expect((yield* catalog.read({ id: "global:shared" })).contents).toBe("shared text");
            expect(
              (yield* catalog.list({})).entries.some((entry) => entry.scope === "global"),
            ).toBe(true);
          }),
        );
      }),
    );

    it.effect("refuses ids the table doesn't have", () =>
      Effect.gen(function* () {
        const { home, project } = yield* makeMachine;
        yield* onMachine(home, CLAUDE, (catalog) =>
          Effect.gen(function* () {
            const ids = [
              "project:shared:../AGENTS.md",
              "project:shared:CLAUDE.md",
              "project:claude:README.md",
              "project:nested:AGENTS.md",
              "project:nested:../outside/AGENTS.md",
              "project:nested:apps/../../AGENTS.md",
              "project:nested:/etc/AGENTS.md",
              "project:nested:apps/web/README.md",
              "global:agentOwn:claudeAgent",
              "global:claude:codex",
              "global:agentOwn:cursor",
              "global:agentOwn:no-such-agent",
              "global:shared:extra",
              "managed:codex",
              "nonsense",
            ];
            for (const id of ids) {
              const error = yield* catalog.read({ cwd: project, id }).pipe(Effect.flip);
              expect(error, id).toBeInstanceOf(InstructionError);
              expect(error.reason, id).toBe("unknownEntry");
            }
            // A project id needs a project.
            const noProject = yield* catalog
              .read({ id: "project:shared:AGENTS.md" })
              .pipe(Effect.flip);
            expect(noProject.reason).toBe("unknownEntry");
          }),
        );
      }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "refuses a subfolder that is a link out of the project",
      () =>
        Effect.gen(function* () {
          const { home, project, write, fs, path } = yield* makeMachine;
          yield* write("elsewhere/AGENTS.md", "outside");
          yield* fs.symlink(path.join(home, "elsewhere"), path.join(project, "linked"));
          yield* onMachine(home, CLAUDE, (catalog) =>
            Effect.gen(function* () {
              const error = yield* catalog
                .read({ cwd: project, id: "project:nested:linked/AGENTS.md" })
                .pipe(Effect.flip);
              expect(error.reason).toBe("unknownEntry");
            }),
          );
        }),
    );
  });
});
