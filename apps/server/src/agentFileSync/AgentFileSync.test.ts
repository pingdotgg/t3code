import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { type AgentFileSyncBundle } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Config from "../config.ts";
import * as KnownWorkspaces from "../workspace/KnownWorkspaces.ts";
import * as AgentFileSync from "./AgentFileSync.ts";

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-agent-sync-" });
  const source = path.join(directory, "source");
  const target = path.join(directory, "target");
  yield* fs.makeDirectory(source);
  yield* fs.makeDirectory(target);
  const write = Effect.fn("fixture.write")(function* (root: string, at: string, contents: string) {
    yield* fs.makeDirectory(path.dirname(path.join(root, at)), { recursive: true });
    yield* fs.writeFileString(path.join(root, at), contents);
  });
  const sync = yield* AgentFileSync.AgentFileSync.pipe(
    Effect.provide(
      AgentFileSync.layer.pipe(
        Layer.provide(Config.layerTest(directory, path.join(directory, "state"))),
        Layer.provide(
          Layer.succeed(KnownWorkspaces.KnownWorkspaces, {
            assertContains: (cwd) =>
              cwd === source || cwd === target
                ? Effect.void
                : Effect.fail(new KnownWorkspaces.UnknownWorkspaceError({ cwd })),
            contains: (cwd) => Effect.succeed(cwd === source || cwd === target),
          }),
        ),
      ),
    ),
    Effect.provideService(HostProcess.HomeDirectory, source),
  );
  const run = Effect.fn("fixture.sync")(function* (bundle: AgentFileSyncBundle) {
    const preview = yield* sync.preview({ cwd: target, bundle });
    return yield* sync.apply({ cwd: target, bundle, expected: preview });
  });
  return { fs, path, directory, source, target, write, sync, run };
});
const sectionBundle = (contents: string): AgentFileSyncBundle => [
  {
    kind: "instructions",
    path: "AGENTS.md",
    sections: [{ id: "Shared:0", title: "Shared", contents }],
  },
];

it.layer(NodeServices.layer)("agent file sync", (it) => {
  it.effect(
    "copies only selected sections, updates without duplicates and restores the exact original",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const local = "# Local\r\nKeep this machine’s settings.\r\n";
        yield* f.write(f.target, "AGENTS.md", local);
        const first = yield* f.run(sectionBundle("## Shared\nRun focused tests.\n"));
        expect(first.failures).toEqual([]);
        const once = yield* f.fs.readFileString(f.path.join(f.target, "AGENTS.md"));
        expect(once).toContain(local);
        expect(once).toContain("## Shared\r\nRun focused tests.");
        expect((yield* f.run(sectionBundle("## Shared\nRun focused tests.\n"))).paths).toEqual([]);
        const second = yield* f.run(sectionBundle("## Shared\nRun updated tests.\n"));
        const twice = yield* f.fs.readFileString(f.path.join(f.target, "AGENTS.md"));
        expect(twice.match(/## Shared/g)).toHaveLength(1);
        expect(twice).toContain("Run updated tests.");
        expect((yield* f.sync.undo({ undoId: second.undoId! })).failures).toEqual([]);
        expect(yield* f.fs.readFileString(f.path.join(f.target, "AGENTS.md"))).toBe(once);
        expect((yield* f.sync.undo({ undoId: first.undoId! })).failures).toEqual([]);
        expect(yield* f.fs.readFileString(f.path.join(f.target, "AGENTS.md"))).toBe(local);
      }),
  );
  it.effect(
    "ongoing sync preserves local instruction text and stops at edits inside managed sections",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const previous = sectionBundle("## Shared\nOriginal rule.");
        yield* f.run(previous);
        const file = f.path.join(f.target, "AGENTS.md");
        const initial = yield* f.fs.readFileString(file);
        yield* f.fs.writeFileString(file, "Local addition.\n" + initial);
        const bundle = sectionBundle("## Shared\nUpdated rule.");
        yield* f.sync.reconcile({ cwd: f.target, previous, bundle });
        const updated = yield* f.fs.readFileString(file);
        expect(updated).toContain("Local addition.");
        expect(updated).toContain("Updated rule.");
        yield* f.sync.reconcile({ cwd: f.target, previous, bundle });
        yield* f.fs.writeFileString(file, updated.replace("Updated rule.", "Local override."));
        expect(
          (yield* f.sync
            .reconcile({ cwd: f.target, previous: bundle, bundle: sectionBundle("Third rule.") })
            .pipe(Effect.flip)).reason,
        ).toBe("changed");
        expect(yield* f.fs.readFileString(file)).toContain("Local override.");
      }),
  );
  it.effect("ongoing sync refuses edited skills and creates no repeated undo receipts", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const previous: AgentFileSyncBundle = [
        {
          kind: "skill",
          path: ".agents/skills/test",
          files: [
            { path: "SKILL.md", data: Buffer.from("Original").toString("base64"), mode: 0o600 },
          ],
        },
      ];
      yield* f.run(previous);
      const bundle: AgentFileSyncBundle = [
        {
          kind: "skill",
          path: ".agents/skills/test",
          files: [
            { path: "SKILL.md", data: Buffer.from("Updated").toString("base64"), mode: 0o600 },
          ],
        },
      ];
      yield* f.sync.reconcile({ cwd: f.target, previous, bundle });
      expect(
        yield* f.fs.readDirectory(f.path.join(f.directory, "state", "userdata", "agent-file-sync")),
      ).toHaveLength(1);
      yield* f.write(f.target, ".agents/skills/test/SKILL.md", "Local edit");
      expect(
        (yield* f.sync
          .reconcile({ cwd: f.target, previous: bundle, bundle: previous })
          .pipe(Effect.flip)).reason,
      ).toBe("changed");
    }),
  );
  it.effect(
    "exports the selected sections and the complete selected skill, including binary and executable files",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const skill = ".agents/skills/deploy";
        yield* f.write(
          f.source,
          "AGENTS.md",
          "# Project\n\n## Shared\nUse tests.\n\n## Local\nOnly here.\n",
        );
        yield* f.write(f.source, `${skill}/SKILL.md`, "---\nname: deploy\n---\nDeploy.");
        yield* f.write(f.source, `${skill}/scripts/deploy.sh`, "#!/bin/sh\nexit 0\n");
        yield* f.fs.chmod(f.path.join(f.source, skill, "scripts/deploy.sh"), 0o750);
        yield* f.fs.writeFile(
          f.path.join(f.source, skill, "image.bin"),
          new Uint8Array([0, 255, 17]),
        );
        const list = yield* f.sync.list({ cwd: f.source });
        expect(list.skills.map((entry) => entry.path)).toEqual([skill]);
        const bundle = yield* f.sync.export({
          cwd: f.source,
          skills: [skill],
          instructions: [{ path: "AGENTS.md", sectionIds: ["Shared:0"] }],
        });
        expect(bundle.find((entry) => entry.kind === "instructions")?.sections).toEqual([
          expect.objectContaining({ title: "Shared", contents: "## Shared\nUse tests.\n\n" }),
        ]);
        yield* f.write(f.target, `${skill}/SKILL.md`, "old");
        yield* f.write(f.target, `${skill}/obsolete.txt`, "stale");
        const applied = yield* f.run(bundle);
        expect(applied.failures).toEqual([]);
        expect(Array.from(yield* f.fs.readFile(f.path.join(f.target, skill, "image.bin")))).toEqual(
          [0, 255, 17],
        );
        expect(
          (yield* f.fs.stat(f.path.join(f.target, skill, "scripts/deploy.sh"))).mode & 0o777,
        ).toBe(0o750);
        expect(yield* f.fs.exists(f.path.join(f.target, skill, "obsolete.txt"))).toBe(false);
        expect(yield* f.fs.readFileString(f.path.join(f.target, "AGENTS.md"))).not.toContain(
          "Only here.",
        );
        yield* f.sync.undo({ undoId: applied.undoId! });
        expect(yield* f.fs.readFileString(f.path.join(f.target, skill, "SKILL.md"))).toBe("old");
        expect(yield* f.fs.exists(f.path.join(f.target, skill, "obsolete.txt"))).toBe(true);
        expect(yield* f.fs.exists(f.path.join(f.target, "AGENTS.md"))).toBe(false);
      }),
  );
  it.effect("normalizes new Windows instruction revisions before saving undo history", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const windowsFs = FileSystem.FileSystem.of({
        ...fs,
        chmod: (at, mode) => fs.chmod(at, mode & 0o200 ? 0o666 : 0o444),
      });
      const f = yield* fixture.pipe(
        Effect.provideService(FileSystem.FileSystem, windowsFs),
        Effect.provideService(HostProcess.Platform, "win32"),
      );
      const applied = yield* f.run(sectionBundle("Shared Windows rules"));
      expect(applied.failures).toEqual([]);
      expect((yield* fs.stat(f.path.join(f.target, "AGENTS.md"))).mode & 0o777).toBe(0o666);
      const undone = yield* f.sync.undo({ undoId: applied.undoId! });
      expect(undone.failures).toEqual([]);
      expect(yield* fs.exists(f.path.join(f.target, "AGENTS.md"))).toBe(false);
    }),
  );
  it.effect("compares Windows skill permissions using its writable bit", () =>
    Effect.gen(function* () {
      const f = yield* fixture.pipe(Effect.provideService(HostProcess.Platform, "win32"));
      const bundle: AgentFileSyncBundle = [
        {
          kind: "skill",
          path: ".agents/skills/review",
          files: [
            { path: "SKILL.md", data: Buffer.from("Review").toString("base64"), mode: 0o750 },
          ],
        },
      ];
      yield* f.run(bundle);
      expect(
        (yield* f.fs.stat(f.path.join(f.target, ".agents/skills/review/SKILL.md"))).mode & 0o777,
      ).toBe(0o666);
      yield* f.sync.reconcile({ cwd: f.target, previous: bundle, bundle });
      expect((yield* f.sync.preview({ cwd: f.target, bundle }))[0]?.changed).toBe(false);
    }),
  );
  it.effect("keeps nested skill revisions stable through preview, reconcile and undo", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const skill = ".agents/skills/nested";
      yield* f.write(f.target, `${skill}/SKILL.md`, "Original");
      const bundle: AgentFileSyncBundle = [
        {
          kind: "skill",
          path: skill,
          files: ["SKILL.md", "a/x.txt", "a.txt"].map((path) => ({
            path,
            data: Buffer.from(path).toString("base64"),
            mode: 0o600,
          })),
        },
      ];
      const applied = yield* f.run(bundle);
      expect(applied.failures).toEqual([]);
      expect((yield* f.sync.preview({ cwd: f.target, bundle }))[0]?.changed).toBe(false);
      const updated = bundle.map((resource) =>
        resource.kind === "skill"
          ? {
              ...resource,
              files: resource.files.map((file) => ({
                ...file,
                data: Buffer.from("Updated").toString("base64"),
              })),
            }
          : resource,
      );
      yield* f.sync.reconcile({ cwd: f.target, previous: bundle, bundle: updated });
      yield* f.sync.reconcile({ cwd: f.target, previous: updated, bundle });
      expect((yield* f.sync.undo({ undoId: applied.undoId! })).failures).toEqual([]);
      expect(yield* f.fs.readFileString(f.path.join(f.target, skill, "SKILL.md"))).toBe("Original");
    }),
  );
  it.effect("rejects imported skill paths beyond the readable depth before any writes", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const skill = ".agents/skills/deep";
      const deepFile = Array.from({ length: 11 }, () => "a").join("/") + "/file.txt";
      const files = ["SKILL.md", deepFile].map((path) => ({
        path,
        data: Buffer.from(path).toString("base64"),
        mode: 0o600,
      }));
      const bundle: AgentFileSyncBundle = [{ kind: "skill", path: skill, files }];
      const applied = yield* f.run(bundle);
      expect(applied.failures).toEqual([]);
      expect((yield* f.sync.preview({ cwd: f.target, bundle }))[0]?.changed).toBe(false);
      const tooDeep: AgentFileSyncBundle = [
        ...sectionBundle("Must not be written"),
        { kind: "skill", path: skill, files: [...files, { ...files[1]!, path: `a/${deepFile}` }] },
      ];
      expect(
        (yield* f.sync.preview({ cwd: f.target, bundle: tooDeep }).pipe(Effect.flip)).reason,
      ).toBe("limit");
      expect(
        (yield* f.sync.apply({ cwd: f.target, bundle: tooDeep, expected: [] }).pipe(Effect.flip))
          .reason,
      ).toBe("limit");
      expect(yield* f.fs.exists(f.path.join(f.target, "AGENTS.md"))).toBe(false);
      expect((yield* f.sync.undo({ undoId: applied.undoId! })).failures).toEqual([]);
      expect(yield* f.fs.exists(f.path.join(f.target, skill))).toBe(false);
    }),
  );
  it.effect("refuses a stale preview before writing any selected item", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const bundle = sectionBundle("Shared");
      const expected = yield* f.sync.preview({ cwd: f.target, bundle });
      yield* f.write(f.target, "AGENTS.md", "Changed after preview");
      expect(
        (yield* f.sync.apply({ cwd: f.target, bundle, expected }).pipe(Effect.flip)).reason,
      ).toBe("changed");
      expect(yield* f.fs.readFileString(f.path.join(f.target, "AGENTS.md"))).toBe(
        "Changed after preview",
      );
    }),
  );
  it.effect("undo refuses to discard edits made after a sync", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const result = yield* f.run(sectionBundle("Shared"));
      yield* f.write(f.target, "AGENTS.md", "Edited after sync");
      const undone = yield* f.sync.undo({ undoId: result.undoId! });
      expect(undone.failures).toHaveLength(1);
      expect(yield* f.fs.readFileString(f.path.join(f.target, "AGENTS.md"))).toBe(
        "Edited after sync",
      );
    }),
  );
  it.effect(
    "rejects traversal, provider credentials, nested skill paths and reserved Windows names",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        for (const at of [
          "../outside",
          ".codex/auth.json",
          ".agents/skills/../escape",
          ".agents/skills/CON",
          ".agents/skills/nested/skill",
        ]) {
          const bundle: AgentFileSyncBundle = [
            { kind: "skill", path: at, files: [{ path: "SKILL.md", data: "", mode: 0o600 }] },
          ];
          expect((yield* f.sync.preview({ cwd: f.target, bundle }).pipe(Effect.flip)).reason).toBe(
            "invalid-path",
          );
        }
        expect(
          (yield* f.sync
            .preview({ cwd: f.directory, bundle: sectionBundle("text") })
            .pipe(Effect.flip)).reason,
        ).toBe("io");
      }),
  );
  it.effect("reads a linked source skill but refuses linked destination directories", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.write(f.directory, "canonical/SKILL.md", "Shared skill");
      yield* f.fs.makeDirectory(f.path.join(f.source, ".agents/skills"), { recursive: true });
      yield* f.fs.symlink(
        f.path.join(f.directory, "canonical"),
        f.path.join(f.source, ".agents/skills/shared"),
      );
      const bundle = yield* f.sync.export({
        cwd: f.source,
        skills: [".agents/skills/shared"],
        instructions: [],
      });
      yield* f.fs.makeDirectory(f.path.join(f.target, ".agents"));
      yield* f.fs.symlink(
        f.path.join(f.source, ".agents/skills"),
        f.path.join(f.target, ".agents/skills"),
      );
      expect((yield* f.sync.preview({ cwd: f.target, bundle }).pipe(Effect.flip)).reason).toBe(
        "linked-destination",
      );
      expect(yield* f.fs.readFileString(f.path.join(f.directory, "canonical/SKILL.md"))).toBe(
        "Shared skill",
      );
    }),
  );
  it.effect("rejects an incompatible destination before writing any other selected item", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const bundle: AgentFileSyncBundle = [
        ...sectionBundle("Shared"),
        {
          kind: "instructions",
          path: "CLAUDE.md",
          sections: [{ id: "Rules:0", title: "Rules", contents: "Rules" }],
        },
      ];
      const expected = yield* f.sync.preview({ cwd: f.target, bundle });
      yield* f.fs.makeDirectory(f.path.join(f.target, "CLAUDE.md"));
      const rejected = yield* f.sync.apply({ cwd: f.target, bundle, expected }).pipe(Effect.flip);
      expect(rejected.reason).toBe("linked-destination");
      expect(yield* f.fs.exists(f.path.join(f.target, "AGENTS.md"))).toBe(false);
    }),
  );
  it.effect("enforces file bounds before reading or writing oversized files", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.write(f.source, ".agents/skills/large/SKILL.md", "x".repeat(1024 * 1024 + 1));
      expect(
        (yield* f.sync
          .export({ cwd: f.source, skills: [".agents/skills/large"], instructions: [] })
          .pipe(Effect.flip)).reason,
      ).toBe("limit");
    }),
  );
  it.effect(
    "allows 256 skill files with trailing empty directories and rejects the 257th file",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const skill = ".agents/skills/boundary";
        yield* f.write(f.source, `${skill}/SKILL.md`, "Boundary skill");
        for (let index = 0; index < 255; index++) {
          yield* f.write(f.source, `${skill}/f${String(index).padStart(3, "0")}.txt`, "text");
        }
        yield* f.fs.makeDirectory(f.path.join(f.source, skill, "zz-empty"));
        const selection = { cwd: f.source, skills: [skill], instructions: [] };
        const bundle = yield* f.sync.export(selection);
        expect(bundle[0]?.kind === "skill" && bundle[0].files.length).toBe(256);
        expect((yield* f.run(bundle)).failures).toEqual([]);
        yield* f.fs.makeDirectory(f.path.join(f.target, skill, "zz-empty"));
        expect((yield* f.sync.preview({ cwd: f.target, bundle }))[0]?.changed).toBe(false);
        yield* f.write(f.source, `${skill}/extra.txt`, "Too many");
        expect((yield* f.sync.export(selection).pipe(Effect.flip)).reason).toBe("limit");
      }),
  );
  it.effect("keeps skill directories private when applying and undoing a replacement", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const skill = ".agents/skills/private";
      yield* f.write(f.target, `${skill}/SKILL.md`, "Original");
      yield* f.write(f.target, `${skill}/scripts/check.sh`, "Original script");
      for (const at of [skill, `${skill}/scripts`])
        yield* f.fs.chmod(f.path.join(f.target, at), 0o700);
      const applied = yield* f.run([
        {
          kind: "skill",
          path: skill,
          files: ["SKILL.md", "scripts/check.sh"].map((path) => ({
            path,
            data: Buffer.from("Updated").toString("base64"),
            mode: 0o600,
          })),
        },
      ]);
      expect(applied.failures).toEqual([]);
      for (const at of [skill, `${skill}/scripts`])
        expect((yield* f.fs.stat(f.path.join(f.target, at))).mode & 0o777).toBe(0o700);
      expect((yield* f.sync.undo({ undoId: applied.undoId! })).failures).toEqual([]);
      for (const at of [skill, `${skill}/scripts`])
        expect((yield* f.fs.stat(f.path.join(f.target, at))).mode & 0o777).toBe(0o700);
      expect(yield* f.fs.readFileString(f.path.join(f.target, skill, "SKILL.md"))).toBe("Original");
    }),
  );
  it.effect.each(["staging", "backup", "install"] as const)(
    "preserves a local skill edit made during %s and stops automatic reconciliation",
    (phase) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        let armed = false;
        let absolute = "";
        let backup = "";
        const localEdit = (at: string) => {
          armed = false;
          return fs.writeFileString(path.join(at, "SKILL.md"), "Concurrent local edit");
        };
        const intercepted = FileSystem.FileSystem.of({
          ...fs,
          writeFile: (at, data, options) =>
            fs
              .writeFile(at, data, options)
              .pipe(
                Effect.andThen(
                  Effect.suspend(() =>
                    armed && phase === "staging" && at.includes(`${path.sep}new${path.sep}`)
                      ? localEdit(absolute)
                      : Effect.void,
                  ),
                ),
              ),
          rename: (from, to) =>
            fs.rename(from, to).pipe(
              Effect.andThen(
                Effect.suspend(() => {
                  if (to.includes(".t3-sync-backup-")) {
                    backup = to;
                    if (armed && phase === "backup") return localEdit(backup);
                  }
                  if (
                    armed &&
                    phase === "install" &&
                    from.endsWith(`${path.sep}new`) &&
                    to === absolute
                  )
                    return localEdit(backup);
                  return Effect.void;
                }),
              ),
            ),
        });
        const f = yield* fixture.pipe(Effect.provideService(FileSystem.FileSystem, intercepted));
        const skill = ".agents/skills/concurrent";
        absolute = path.join(f.target, skill);
        const previous: AgentFileSyncBundle = [
          {
            kind: "skill",
            path: skill,
            files: [
              { path: "SKILL.md", data: Buffer.from("Original").toString("base64"), mode: 0o600 },
            ],
          },
        ];
        yield* f.run(previous);
        const bundle: AgentFileSyncBundle = [
          {
            kind: "skill",
            path: skill,
            files: [
              { path: "SKILL.md", data: Buffer.from("Updated").toString("base64"), mode: 0o600 },
            ],
          },
        ];
        armed = true;
        const error = yield* f.sync
          .reconcile({ cwd: f.target, previous, bundle })
          .pipe(Effect.flip);
        expect(error.reason).toBe(phase === "install" ? "changed-backup" : "changed");
        const preserved = phase === "install" ? backup : absolute;
        expect(yield* fs.readFileString(path.join(preserved, "SKILL.md"))).toBe(
          "Concurrent local edit",
        );
        if (phase === "install") expect(error.message).toContain(backup);
        expect(
          yield* fs.readDirectory(path.join(f.directory, "state/userdata/agent-file-sync")),
        ).toHaveLength(1);
      }),
  );

  it.effect("leaves original instructions in place when hard links are unavailable", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const intercepted = FileSystem.FileSystem.of({ ...fs, link: (from) => fs.link(from, from) });
      const f = yield* fixture.pipe(Effect.provideService(FileSystem.FileSystem, intercepted));
      yield* f.write(f.target, "AGENTS.md", "Original host rules");
      const result = yield* f.run(sectionBundle("Shared"));
      expect(result.failures).toHaveLength(1);
      expect(yield* fs.readFileString(f.path.join(f.target, "AGENTS.md"))).toBe(
        "Original host rules",
      );
      expect((yield* f.sync.undo({ undoId: result.undoId! })).failures).toEqual([]);
      expect(
        (yield* fs.readDirectory(f.target)).some((name) => name.includes(".t3-sync-backup-")),
      ).toBe(false);
    }),
  );
  it.effect("rejects case-aliased skill roots before writing other selected resources", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const bundle: AgentFileSyncBundle = [
        ...sectionBundle("Must not be written"),
        ...["Review", "review"].map((name) => ({
          kind: "skill" as const,
          path: `.agents/skills/${name}`,
          files: [{ path: "SKILL.md", data: Buffer.from("Skill").toString("base64"), mode: 0o600 }],
        })),
      ];
      expect((yield* f.sync.preview({ cwd: f.target, bundle }).pipe(Effect.flip)).reason).toBe(
        "invalid-path",
      );
      expect(
        (yield* f.sync.apply({ cwd: f.target, bundle, expected: [] }).pipe(Effect.flip)).reason,
      ).toBe("invalid-path");
      expect(yield* f.fs.exists(f.path.join(f.target, "AGENTS.md"))).toBe(false);
      expect(yield* f.fs.exists(f.path.join(f.target, ".agents"))).toBe(false);
    }),
  );
  it.effect("rejects case-aliased skill parent directories before any writes", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const skill = ".agents/skills/case-alias";
      const bundle: AgentFileSyncBundle = [
        ...sectionBundle("Must not be written"),
        {
          kind: "skill",
          path: skill,
          files: ["SKILL.md", "Scripts/a.txt", "scripts/b.txt"].map((path) => ({
            path,
            data: Buffer.from(path).toString("base64"),
            mode: 0o600,
          })),
        },
      ];
      expect((yield* f.sync.preview({ cwd: f.target, bundle }).pipe(Effect.flip)).reason).toBe(
        "invalid-path",
      );
      expect(
        (yield* f.sync.apply({ cwd: f.target, bundle, expected: [] }).pipe(Effect.flip)).reason,
      ).toBe("invalid-path");
      expect(yield* f.fs.exists(f.path.join(f.target, "AGENTS.md"))).toBe(false);
      expect(yield* f.fs.exists(f.path.join(f.target, skill))).toBe(false);
    }),
  );
  it.effect.each(["capture", "backup", "install", "recreated"] as const)(
    "preserves local instruction edits during %s",
    (phase) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        let armed = false;
        let absolute = "";
        let backup = "";
        const local = "Local host text added during sync";
        const append = (at: string) =>
          fs
            .readFileString(at)
            .pipe(Effect.flatMap((text) => fs.writeFileString(at, `${text}\n${local}\n`)));
        const intercepted = FileSystem.FileSystem.of({
          ...fs,
          rename: (from, to) =>
            Effect.gen(function* () {
              if (
                armed &&
                phase === "capture" &&
                (from === absolute || (from.endsWith(`${path.sep}new`) && to === absolute))
              ) {
                armed = false;
                yield* append(absolute);
              }
              yield* fs.rename(from, to);
              if (from === absolute && to.includes(".t3-sync-backup-")) {
                backup = to;
                if (armed && phase === "backup") {
                  armed = false;
                  yield* append(backup);
                }
                if (armed && phase === "recreated") {
                  armed = false;
                  yield* fs.writeFileString(absolute, local);
                }
              }
              if (
                armed &&
                phase === "install" &&
                to === absolute &&
                from.endsWith(`${path.sep}new`)
              ) {
                armed = false;
                yield* append(backup);
              }
            }),
          link: (from, to) =>
            fs.link(from, to).pipe(
              Effect.andThen(
                Effect.suspend(() => {
                  if (armed && phase === "install" && to === absolute) {
                    armed = false;
                    return append(backup);
                  }
                  return Effect.void;
                }),
              ),
            ),
        });
        const f = yield* fixture.pipe(Effect.provideService(FileSystem.FileSystem, intercepted));
        absolute = path.join(f.target, "AGENTS.md");
        const previous = sectionBundle("Original");
        yield* f.write(f.target, "AGENTS.md", "Local original text\n");
        yield* f.run(previous);
        armed = true;
        const error = yield* f.sync
          .reconcile({ cwd: f.target, previous, bundle: sectionBundle("Updated") })
          .pipe(Effect.flip);
        expect(error.reason).toBe(
          phase === "install" || phase === "recreated" ? "changed-backup" : "changed",
        );
        expect(armed).toBe(false);
        const preserved = phase === "install" ? backup : absolute;
        expect(yield* fs.readFileString(preserved)).toContain(local);
        if (phase === "install" || phase === "recreated") {
          expect(error.message).toContain(backup);
          expect(yield* fs.readFileString(backup)).toContain("Local original text");
        }
        expect(
          yield* fs.readDirectory(path.join(f.directory, "state/userdata/agent-file-sync")),
        ).toHaveLength(1);
      }),
  );
  it.effect("finds valid skills after 500 entries without a skill manifest", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      for (let index = 0; index < 500; index++)
        yield* f.fs.makeDirectory(f.path.join(f.source, ".agents/skills", `a${index}`), {
          recursive: true,
        });
      yield* f.write(f.source, ".agents/skills/z-valid/SKILL.md", "Valid skill");
      const catalog = yield* f.sync.list({ cwd: f.source });
      expect(catalog.skills.map((skill) => skill.path)).toEqual([".agents/skills/z-valid"]);
      expect(catalog.warnings).toEqual([]);
    }),
  );
  it.effect("caps the inventory at 500 valid skills and emits one truncation warning", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      for (let index = 0; index < 501; index++)
        yield* f.write(
          f.source,
          `.agents/skills/skill-${String(index).padStart(3, "0")}/SKILL.md`,
          "Skill",
        );
      const catalog = yield* f.sync.list({ cwd: f.source });
      expect(catalog.skills).toHaveLength(500);
      expect(catalog.skills[499]?.name).toBe("skill-499");
      expect(catalog.warnings).toHaveLength(1);
      expect(catalog.warnings[0]).toContain("500");
    }),
  );
  it.effect("exports 100 skills together with every supported personal instruction file", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const skills = Array.from({ length: 100 }, (_, index) => `.agents/skills/skill-${index}`);
      for (const skill of skills) yield* f.write(f.source, `${skill}/SKILL.md`, "Skill");
      const paths = [
        "AGENTS.md",
        "CLAUDE.md",
        ".agents/AGENTS.md",
        ".codex/AGENTS.md",
        ".claude/CLAUDE.md",
        ".config/opencode/AGENTS.md",
      ];
      for (const path of paths) yield* f.write(f.source, path, "## Shared\nRules");
      const bundle = yield* f.sync.export({
        skills,
        instructions: paths.map((path) => ({ path, sectionIds: ["Shared:0"] })),
      });
      expect(bundle).toHaveLength(106);
      expect(yield* f.sync.preview({ bundle })).toHaveLength(106);
    }),
  );
  it.effect("personal sync uses the environment's home and never scans provider credentials", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.write(f.source, ".codex/AGENTS.md", "Personal rules");
      yield* f.write(f.source, ".codex/auth.json", "private");
      const catalog = yield* f.sync.list({});
      expect(catalog.instructions.map((file) => file.path)).toEqual([".codex/AGENTS.md"]);
      expect(catalog.instructions[0]?.sections[0]?.contents).toBe("Personal rules");
    }),
  );
});
