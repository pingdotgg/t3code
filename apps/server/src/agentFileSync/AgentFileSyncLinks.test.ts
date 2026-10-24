import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, type AgentFileSyncBundle } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as Config from "../config.ts";
import * as KnownWorkspaces from "../workspace/KnownWorkspaces.ts";
import * as AgentFileSync from "./AgentFileSync.ts";
import * as AgentFileSyncLinks from "./AgentFileSyncLinks.ts";

const bundle = (text: string): AgentFileSyncBundle => [
  {
    kind: "instructions",
    path: "AGENTS.md",
    sections: [{ id: "Shared:0", title: "Shared", contents: `## Shared\n${text}\n` }],
  },
];
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sync-links-" });
  const config = Config.layerTest(directory, path.join(directory, "data"));
  const storage = new Map<string, Uint8Array>();
  const writes: string[] = [];
  const failWrites = new Set<string>();
  const failAfterWrites = new Set<string>();
  const afterWrites = new Map<string, Effect.Effect<unknown>>();
  const failReads = new Set<string>();
  const secrets = Layer.succeed(
    ServerSecretStore.ServerSecretStore,
    ServerSecretStore.ServerSecretStore.of({
      get: (name) =>
        Effect.suspend(() =>
          failReads.has(name)
            ? Effect.fail(
                new ServerSecretStore.SecretStoreReadError({
                  resource: name,
                  cause: "PRIVATE READ ERROR",
                }),
              )
            : Effect.sync(() => Option.fromNullishOr(storage.get(name))),
        ),
      set: (name, data) =>
        Effect.suspend(() =>
          failWrites.has(name)
            ? Effect.fail(
                new ServerSecretStore.SecretStorePersistError({
                  resource: name,
                  cause: "test write failure",
                }),
              )
            : Effect.gen(function* () {
                storage.set(name, Uint8Array.from(data));
                writes.push(name);
                const afterWrite = afterWrites.get(name);
                if (afterWrite) yield* afterWrite;
                if (failAfterWrites.has(name))
                  return yield* new ServerSecretStore.SecretStorePersistError({
                    resource: name,
                    cause: "test failure after publication",
                  });
              }),
        ),
      create: () => Effect.void,
      remove: (name) =>
        Effect.sync(() => {
          storage.delete(name);
        }),
      getOrCreateRandom: () => Effect.succeed(new Uint8Array(32)),
    }),
  );
  const fileLayer = AgentFileSync.layer.pipe(
    Layer.provide(config),
    Layer.provide(
      Layer.succeed(KnownWorkspaces.KnownWorkspaces, {
        assertContains: () => Effect.void,
        contains: () => Effect.succeed(true),
      }),
    ),
  );
  const files = yield* AgentFileSync.AgentFileSync.pipe(
    Effect.provide(fileLayer),
    Effect.provideService(HostProcess.HomeDirectory, directory),
  );
  const load = AgentFileSyncLinks.AgentFileSyncLinks.pipe(
    Effect.provide(AgentFileSyncLinks.layer.pipe(Layer.provide(secrets))),
    Effect.provideService(AgentFileSync.AgentFileSync, files),
    Effect.provideService(HostProcess.HomeDirectory, directory),
  );
  const links = yield* load;
  const subscribe = Effect.fn("fixture.subscribe")(function* () {
    yield* links.subscribe({
      sourceEnvironmentId: EnvironmentId.make("source"),
      selection: { skills: [], instructions: [{ path: "AGENTS.md", sectionIds: ["Shared:0"] }] },
      label: "Source",
      bundle: bundle("Initial"),
      expected: yield* files.preview({ bundle: bundle("Initial") }),
    });
    return (yield* links.list)[0]!;
  });
  return {
    fs,
    path,
    directory,
    files,
    links,
    load,
    subscribe,
    storage,
    writes,
    failWrites,
    failAfterWrites,
    afterWrites,
    failReads,
  };
});

it.layer(NodeServices.layer)("sync subscriptions", (it) => {
  it.effect(
    "starts with no subscriptions when saved metadata is malformed, without logging its contents",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const logs: unknown[] = [];
        const logger = Logger.make(({ message }) => logs.push(message));
        for (const corrupt of [
          "PRIVATE FILE CONTENTS",
          JSON.stringify([{ previous: "PRIVATE FILE CONTENTS" }]),
        ]) {
          f.storage.set("agent-file-sync-links", Buffer.from(corrupt));
          const recovered = yield* f.load.pipe(
            Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
          );
          expect(yield* recovered.list).toEqual([]);
          expect(Buffer.from(f.storage.get("agent-file-sync-links")!).toString()).toBe(corrupt);
        }
        expect(logs).toHaveLength(2);
        expect(JSON.stringify(logs)).not.toContain("PRIVATE FILE CONTENTS");
      }),
  );
  it.effect("reports the subscription count limit before changing any destination file", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      for (let index = 0; index < 20; index++) {
        const cwd = f.path.join(f.directory, String(index));
        yield* f.fs.makeDirectory(cwd);
        yield* f.links.subscribe({
          cwd,
          sourceEnvironmentId: EnvironmentId.make("source"),
          selection: {
            skills: [],
            instructions: [{ path: "AGENTS.md", sectionIds: ["Shared:0"] }],
          },
          label: "Source",
          bundle: bundle("Initial"),
          expected: yield* f.files.preview({ cwd, bundle: bundle("Initial") }),
        });
      }
      const rejected = yield* f.subscribe().pipe(Effect.flip);
      expect(rejected.reason).toBe("subscription-limit");
      expect(rejected.message).toContain("20 sync subscriptions");
      expect(yield* f.fs.exists(f.path.join(f.directory, "AGENTS.md"))).toBe(false);
    }),
  );
  it.effect("persists only changed baselines and removes obsolete baseline files", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const link = yield* f.subscribe();
      const cwd = f.path.join(f.directory, "other");
      yield* f.fs.makeDirectory(cwd);
      yield* f.links.subscribe({
        cwd,
        sourceEnvironmentId: EnvironmentId.make("other-source"),
        selection: { skills: [], instructions: [{ path: "AGENTS.md", sectionIds: ["Shared:0"] }] },
        label: "Other",
        bundle: bundle("Other rules"),
        expected: yield* f.files.preview({ cwd, bundle: bundle("Other rules") }),
      });
      const other = (yield* f.links.list)[1]!;
      expect(Buffer.from(f.storage.get("agent-file-sync-links")!).toString()).not.toContain(
        "Initial",
      );
      const baselineKeys = () =>
        [...f.storage.keys()].filter((key) => key !== "agent-file-sync-links");
      const original = baselineKeys();
      expect(original).toHaveLength(2);
      const writesBeforePause = f.writes.length;
      yield* f.links.manage({ id: link.id, action: "pause" });
      expect(f.writes.slice(writesBeforePause)).toEqual(["agent-file-sync-links"]);
      expect(baselineKeys()).toEqual(original);
      yield* f.links.manage({ id: link.id, action: "resume" });
      const resumed = (yield* f.links.list)[0]!;
      const writesBeforeChange = f.writes.length;
      yield* f.links.refresh({
        id: link.id,
        generation: resumed.generation,
        bundle: bundle("Changed"),
      });
      expect(
        f.writes
          .slice(writesBeforeChange)
          .filter((key) => !key.startsWith("agent-file-sync-pending-")),
      ).toHaveLength(2);
      expect(baselineKeys()).toHaveLength(2);
      expect(baselineKeys().filter((key) => original.includes(key))).toHaveLength(1);
      expect(baselineKeys()).not.toEqual(original);
      const current = (yield* f.links.list)[0]!;
      const writesBeforeCheck = f.writes.length;
      yield* f.links.refresh({ id: link.id, generation: current.generation, bundle: null });
      expect(f.writes).toHaveLength(writesBeforeCheck);
      expect(yield* (yield* f.load).list).toEqual([current, other]);
      yield* f.links.manage({ id: link.id, action: "remove" });
      expect(baselineKeys()).toHaveLength(1);
      yield* f.links.manage({ id: other.id, action: "remove" });
      expect(baselineKeys()).toEqual([]);
      expect(yield* (yield* f.load).list).toEqual([]);
    }),
  );
  it.effect("keeps the prior baseline readable when publishing updated metadata fails", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const original = yield* f.subscribe();
      const saved = f.storage.get("agent-file-sync-links");
      f.failWrites.add("agent-file-sync-links");
      expect(
        (yield* f.links
          .refresh({ id: original.id, generation: 0, bundle: bundle("Changed") })
          .pipe(Effect.flip)).reason,
      ).toBe("io");
      expect(f.storage.get("agent-file-sync-links")).toEqual(saved);
      const restarted = yield* f.load;
      expect(yield* restarted.list).toEqual([original]);
      f.failWrites.clear();
      yield* restarted.refresh({ id: original.id, generation: 0, bundle: bundle("Changed") });
      expect((yield* restarted.list)[0]?.generation).toBe(1);
      expect([...f.storage.keys()].filter((key) => key !== "agent-file-sync-links")).toHaveLength(
        1,
      );
      expect(yield* f.fs.readFileString(f.path.join(f.directory, "AGENTS.md"))).toContain(
        "Changed",
      );
    }),
  );
  it.effect("removes unpublished setup baselines while preserving existing subscriptions", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const original = yield* f.subscribe();
      const saved = new Map(f.storage);
      const cwd = f.path.join(f.directory, "new");
      yield* f.fs.makeDirectory(cwd);
      f.failWrites.add("agent-file-sync-links");
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = yield* f.links
          .subscribe({
            cwd,
            sourceEnvironmentId: EnvironmentId.make("new-source"),
            selection: {
              skills: [],
              instructions: [{ path: "AGENTS.md", sectionIds: ["Shared:0"] }],
            },
            label: "New source",
            bundle: bundle("New rules"),
            expected: yield* f.files.preview({ cwd, bundle: bundle("New rules") }),
          })
          .pipe(Effect.result);
        expect(result).toMatchObject({ _tag: "Failure", failure: { reason: "io" } });
        expect(f.storage).toEqual(saved);
        expect(yield* f.fs.exists(f.path.join(cwd, "AGENTS.md"))).toBe(false);
        expect(yield* (yield* f.load).list).toEqual([original]);
      }
    }),
  );
  it.effect.each(["subscribe", "remove", "refresh"] as const)(
    "finishes %s publication when its request is interrupted after the catalog write",
    (action) =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const original = action === "subscribe" ? null : yield* f.subscribe();
        const published = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        f.afterWrites.set(
          "agent-file-sync-links",
          Deferred.succeed(published, undefined).pipe(Effect.andThen(Deferred.await(release))),
        );
        const operation =
          action === "subscribe"
            ? f.subscribe().pipe(Effect.asVoid)
            : action === "remove"
              ? f.links.manage({ id: original!.id, action: "remove" })
              : f.links.refresh({ id: original!.id, generation: 0, bundle: bundle("Updated") });
        const request = yield* operation.pipe(Effect.forkChild);
        yield* Deferred.await(published);
        const interrupted = yield* Fiber.interrupt(request).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(interrupted);
        const current = yield* f.links.list;
        expect(current).toEqual(yield* (yield* f.load).list);
        expect(current).toHaveLength(action === "remove" ? 0 : 1);
        if (action === "subscribe") {
          expect((yield* f.subscribe().pipe(Effect.flip)).reason).toBe("overlap");
          expect(
            yield* f.fs.readDirectory(f.path.join(f.directory, "data/userdata/agent-file-sync")),
          ).toEqual([]);
        } else if (action === "remove") {
          expect((yield* f.subscribe()).id).not.toBe(original!.id);
        } else {
          expect(current[0]?.generation).toBe(1);
          yield* f.links.manage({ id: original!.id, action: "pause" });
          expect(yield* f.links.list).toEqual(yield* (yield* f.load).list);
          expect(yield* f.fs.readFileString(f.path.join(f.directory, "AGENTS.md"))).toContain(
            "Updated",
          );
        }
      }),
  );
  it.effect(
    "keeps committed setup after a post-publication error and rejects overlapping retries",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        f.failAfterWrites.add("agent-file-sync-links");
        const result = yield* f.subscribe().pipe(Effect.result);
        expect(result._tag).toBe("Success");
        const saved = yield* f.links.list;
        expect(saved).toHaveLength(1);
        expect(yield* (yield* f.load).list).toEqual(saved);
        expect(yield* f.fs.readFileString(f.path.join(f.directory, "AGENTS.md"))).toContain(
          "Initial",
        );
        expect(
          yield* f.fs.readDirectory(f.path.join(f.directory, "data/userdata/agent-file-sync")),
        ).toEqual([]);
        expect((yield* f.subscribe().pipe(Effect.flip)).reason).toBe("overlap");
        expect(yield* f.links.list).toEqual(saved);
      }),
  );
  it.effect.each(["before", "after"] as const)(
    "retains setup files and recovery receipt when a failure %s publication cannot be verified",
    (when) =>
      Effect.gen(function* () {
        const f = yield* fixture;
        (when === "before" ? f.failWrites : f.failAfterWrites).add("agent-file-sync-links");
        f.failReads.add("agent-file-sync-links");
        const result = yield* f.subscribe().pipe(Effect.result);
        expect(result).toMatchObject({ _tag: "Failure", failure: { reason: "recovery" } });
        if (result._tag !== "Failure") return;
        const undoId = result.failure.path!;
        expect(
          yield* f.fs.exists(
            f.path.join(f.directory, "data/userdata/agent-file-sync", `${undoId}.json`),
          ),
        ).toBe(true);
        expect(yield* f.fs.readFileString(f.path.join(f.directory, "AGENTS.md"))).toContain(
          "Initial",
        );
        expect((yield* f.subscribe().pipe(Effect.flip)).reason).toBe("unreadable-state");
        f.failReads.clear();
        const restarted = yield* f.load;
        expect(yield* restarted.list).toHaveLength(when === "before" ? 0 : 1);
        if (when === "before") {
          expect((yield* f.files.undo({ undoId })).failures).toEqual([]);
          expect(yield* f.fs.exists(f.path.join(f.directory, "AGENTS.md"))).toBe(false);
        } else yield* f.files.discard({ undoId });
      }),
  );
  it.effect("preserves baselines referenced by a catalog published before a write error", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const original = yield* f.subscribe();
      f.failAfterWrites.add("agent-file-sync-links");
      const result = yield* f.links
        .refresh({ id: original.id, generation: 0, bundle: bundle("Published") })
        .pipe(Effect.result);
      expect(result._tag).toBe("Success");
      const restarted = yield* f.load;
      expect(yield* restarted.list).toMatchObject([{ id: original.id, generation: 1 }]);
      expect(yield* f.links.list).toEqual(yield* restarted.list);
      f.failAfterWrites.clear();
      yield* restarted.refresh({ id: original.id, generation: 1, bundle: bundle("Next") });
      expect((yield* restarted.list)[0]?.paused).toBe(false);
      expect(yield* f.fs.readFileString(f.path.join(f.directory, "AGENTS.md"))).toContain("Next");
    }),
  );
  it.effect("ignores missing, malformed or mismatched baselines without logging contents", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.subscribe();
      const key = [...f.storage.keys()].find((key) => key !== "agent-file-sync-links")!;
      const original = f.storage.get(key)!;
      const logs: unknown[] = [];
      const logger = Logger.make(({ message }) => logs.push(message));
      for (const contents of [
        undefined,
        Buffer.from("PRIVATE FILE CONTENTS"),
        Buffer.from(JSON.stringify(bundle("PRIVATE FILE CONTENTS"))),
      ]) {
        if (contents) f.storage.set(key, contents);
        else f.storage.delete(key);
        const recovered = yield* f.load.pipe(
          Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
        );
        expect(yield* recovered.list).toEqual([]);
      }
      expect(logs).toHaveLength(3);
      expect(JSON.stringify(logs)).not.toContain("PRIVATE FILE CONTENTS");
      f.storage.set(key, original);
      expect(yield* (yield* f.load).list).toHaveLength(1);
    }),
  );
  it.effect("survives restarts and never exposes baseline file contents in its catalog", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const link = yield* f.subscribe();
      expect(link).not.toHaveProperty("previous");
      expect(yield* (yield* f.load).list).toEqual([link]);
      expect(
        yield* f.fs.readDirectory(f.path.join(f.directory, "data/userdata/agent-file-sync")),
      ).toEqual([]);
      expect(
        (yield* f.files
          .check({
            selection: {
              cwd: f.directory,
              skills: [],
              instructions: [{ path: "AGENTS.md", sectionIds: ["Shared:0"] }],
            },
            revision: link.revision,
          })
          .pipe(Effect.flip)).reason,
      ).toBe("changed");
    }),
  );
  it.effect("serializes multiple clients and ignores stale generations", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const link = yield* f.subscribe();
      yield* f.links.refresh({ id: link.id, generation: 0, bundle: bundle("New") });
      yield* f.links.refresh({ id: link.id, generation: 0, bundle: bundle("Stale") });
      expect(yield* f.fs.readFileString(f.path.join(f.directory, "AGENTS.md"))).toContain("New");
      const current = (yield* f.links.list)[0]!;
      expect(current.generation).toBe(1);
      yield* f.links.manage({
        id: link.id,
        generation: 0,
        action: "pause",
        error: "Delayed source error",
      });
      expect(yield* f.links.list).toEqual([current]);
      yield* f.links.refresh({ id: link.id, generation: 1, bundle: null });
      expect((yield* f.links.list)[0]!.generation).toBe(1);
    }),
  );
  it.effect("pauses at a conflict, resumes after repair, and removes without deleting files", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const link = yield* f.subscribe();
      const file = f.path.join(f.directory, "AGENTS.md");
      const original = yield* f.fs.readFileString(file);
      yield* f.fs.writeFileString(file, original.replace("Initial", "Local edit"));
      expect(
        (yield* f.links.refresh({ id: link.id, generation: 0, bundle: null }).pipe(Effect.flip))
          .reason,
      ).toBe("changed");
      const paused = (yield* f.links.list)[0]!;
      expect(paused.paused).toBe(true);
      expect(paused.error).toContain("Files changed");
      yield* f.links.refresh({
        id: link.id,
        generation: paused.generation,
        bundle: bundle("Ignored while paused"),
      });
      expect(yield* f.fs.readFileString(file)).toContain("Local edit");
      yield* f.fs.writeFileString(file, original);
      yield* f.links.manage({ id: link.id, action: "resume" });
      const resumed = (yield* f.links.list)[0]!;
      yield* f.links.refresh({
        id: link.id,
        generation: resumed.generation,
        bundle: bundle("Resumed"),
      });
      expect(yield* f.fs.readFileString(file)).toContain("Resumed");
      yield* f.links.manage({ id: link.id, action: "remove" });
      expect(yield* f.links.list).toEqual([]);
      expect(yield* f.fs.readFileString(file)).toContain("Resumed");
    }),
  );
  it.effect("rechecks write permission after waiting for the file lock", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const held = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const queued = yield* Deferred.make<void>();
      const holder = yield* f.files
        .apply(
          { bundle: [], expected: [] },
          false,
          Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(release))),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(held);
      let allowed = true;
      const input = {
        sourceEnvironmentId: EnvironmentId.make("source"),
        selection: { skills: [], instructions: [{ path: "AGENTS.md", sectionIds: ["Shared:0"] }] },
        label: "Source",
        bundle: bundle("Denied"),
        expected: yield* f.files.preview({ bundle: bundle("Denied") }),
      };
      const request = yield* Deferred.succeed(queued, undefined).pipe(
        Effect.andThen(
          f.links.subscribe(
            input,
            Effect.suspend(() =>
              allowed ? Effect.void : Effect.fail("permission-revoked" as const),
            ),
          ),
        ),
        Effect.result,
        Effect.forkChild,
      );
      yield* Deferred.await(queued);
      allowed = false;
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(holder);
      expect(yield* Fiber.join(request)).toMatchObject({
        _tag: "Failure",
        failure: "permission-revoked",
      });
      expect(yield* f.links.list).toEqual([]);
      expect(yield* f.fs.exists(f.path.join(f.directory, "AGENTS.md"))).toBe(false);
    }),
  );
  it.effect(
    "recognizes destination aliases and personal/project scopes sharing the same files",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.subscribe();
        const rejected = yield* f.links
          .subscribe({
            cwd: `${f.directory}/.`,
            sourceEnvironmentId: EnvironmentId.make("another-source"),
            selection: {
              skills: [],
              instructions: [{ path: "AGENTS.md", sectionIds: ["Shared:0"] }],
            },
            label: "Other",
            bundle: bundle("Overwrite"),
            expected: yield* f.files.preview({ bundle: bundle("Overwrite") }),
          })
          .pipe(Effect.flip);
        expect(rejected.reason).toBe("overlap");
        expect(yield* f.fs.readFileString(f.path.join(f.directory, "AGENTS.md"))).toContain(
          "Initial",
        );
      }),
  );
  it.effect("rejects overlapping subscriptions before changing files", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.subscribe();
      expect((yield* f.subscribe().pipe(Effect.flip)).reason).toBe("overlap");
      expect(yield* f.links.list).toHaveLength(1);
    }),
  );
  it.effect("rejects overlapping files across different scope roots", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const cwd = f.path.join(f.directory, ".claude");
      yield* f.fs.makeDirectory(cwd);
      const personal: AgentFileSyncBundle = [
        {
          kind: "instructions",
          path: ".claude/CLAUDE.md",
          sections: [{ id: "Shared:0", title: "Shared", contents: "Shared rules" }],
        },
      ];
      yield* f.links.subscribe({
        sourceEnvironmentId: EnvironmentId.make("source"),
        selection: {
          skills: [],
          instructions: [{ path: ".claude/CLAUDE.md", sectionIds: ["Shared:0"] }],
        },
        label: "Personal",
        bundle: personal,
        expected: yield* f.files.preview({ bundle: personal }),
      });
      const project: AgentFileSyncBundle = [{ ...personal[0]!, path: "CLAUDE.md" }];
      const error = yield* f.links
        .subscribe({
          cwd,
          sourceEnvironmentId: EnvironmentId.make("source"),
          selection: {
            skills: [],
            instructions: [{ path: "CLAUDE.md", sectionIds: ["Shared:0"] }],
          },
          label: "Project",
          bundle: project,
          expected: yield* f.files.preview({ cwd, bundle: project }),
        })
        .pipe(Effect.flip);
      expect(error.reason).toBe("overlap");
      expect(yield* f.links.list).toHaveLength(1);
    }),
  );
  it.effect.each(["empty", "resource", "section"] as const)(
    "accepts a corrected refresh after rejecting changed %s identity",
    (identity) =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const link = yield* f.subscribe();
        const original = yield* f.fs.readFileString(f.path.join(f.directory, "AGENTS.md"));
        const rejected: AgentFileSyncBundle =
          identity === "empty"
            ? []
            : [
                {
                  kind: "instructions",
                  path: identity === "resource" ? "CLAUDE.md" : "AGENTS.md",
                  sections: [
                    {
                      id: identity === "section" ? "Other:0" : "Shared:0",
                      title: "Shared",
                      contents: "Rejected update",
                    },
                  ],
                },
              ];
        const error = yield* f.links
          .refresh({ id: link.id, generation: link.generation, bundle: rejected })
          .pipe(Effect.flip);
        expect(error.reason).toBe("changed");
        expect((yield* f.links.list)[0]).toMatchObject({ paused: true, error: error.message });
        expect(yield* f.fs.readFileString(f.path.join(f.directory, "AGENTS.md"))).toBe(original);
        expect(yield* f.fs.exists(f.path.join(f.directory, "CLAUDE.md"))).toBe(false);
        const restarted = yield* f.load;
        yield* restarted.manage({ id: link.id, action: "resume" });
        const resumed = (yield* restarted.list)[0]!;
        yield* restarted.refresh({
          id: link.id,
          generation: resumed.generation,
          bundle: bundle("Corrected update"),
        });
        expect((yield* restarted.list)[0]).toMatchObject({ paused: false, error: null });
        expect(yield* f.fs.readFileString(f.path.join(f.directory, "AGENTS.md"))).toContain(
          "Corrected update",
        );
        expect(f.writes.filter((key) => key.startsWith("agent-file-sync-pending-"))).toHaveLength(
          1,
        );
      }),
  );
  it.effect("recovers a pending baseline after failed publication when the source advances", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const link = yield* f.subscribe();
      f.failWrites.add("agent-file-sync-links");
      expect(
        (yield* f.links
          .refresh({ id: link.id, generation: 0, bundle: bundle("B") })
          .pipe(Effect.flip)).reason,
      ).toBe("io");
      f.failWrites.clear();
      const restarted = yield* f.load;
      yield* restarted.refresh({ id: link.id, generation: 0, bundle: bundle("C") });
      const recovered = (yield* restarted.list)[0]!;
      expect(recovered.paused).toBe(false);
      yield* restarted.refresh({
        id: link.id,
        generation: recovered.generation,
        bundle: bundle("C"),
      });
      expect((yield* restarted.list)[0]?.paused).toBe(false);
      expect(yield* f.fs.readFileString(f.path.join(f.directory, "AGENTS.md"))).toContain("C");
      expect([...f.storage.keys()].some((key) => key.startsWith("agent-file-sync-pending-"))).toBe(
        false,
      );
    }),
  );
  it.effect.each(["write", "metadata"] as const)(
    "rolls back initial destination writes after a %s failure",
    (failure) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        let failInstall = failure === "write";
        const intercepted = FileSystem.FileSystem.of({
          ...fs,
          link: (from, to) =>
            Effect.suspend(() => {
              if (failInstall && to.endsWith("/AGENTS.md")) {
                failInstall = false;
                return fs.link(from, `${to}/missing-parent/file`);
              }
              return fs.link(from, to);
            }),
        });
        const f = yield* fixture.pipe(Effect.provideService(FileSystem.FileSystem, intercepted));
        const skill = ".agents/skills/setup";
        const absolute = f.path.join(f.directory, skill);
        yield* f.fs.makeDirectory(absolute, { recursive: true });
        yield* f.fs.writeFileString(f.path.join(absolute, "SKILL.md"), "Original local skill");
        const initial: AgentFileSyncBundle = [
          {
            kind: "skill",
            path: skill,
            files: [
              {
                path: "SKILL.md",
                data: Buffer.from("Source skill").toString("base64"),
                mode: 0o600,
              },
            ],
          },
          ...bundle("Shared"),
        ];
        const expected = yield* f.files.preview({ bundle: initial });
        if (failure === "metadata") f.failWrites.add("agent-file-sync-links");
        const error = yield* f.links
          .subscribe({
            sourceEnvironmentId: EnvironmentId.make("source"),
            selection: {
              skills: [skill],
              instructions: [{ path: "AGENTS.md", sectionIds: ["Shared:0"] }],
            },
            label: "Source",
            bundle: initial,
            expected,
          })
          .pipe(Effect.flip);
        expect(error.reason).toBe("io");
        expect(yield* f.links.list).toEqual([]);
        expect(yield* f.fs.readFileString(f.path.join(absolute, "SKILL.md"))).toBe(
          "Original local skill",
        );
      }),
  );
  it.effect("retains an undo receipt when concurrent edits prevent setup rollback", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      let skillPath = "";
      const intercepted = FileSystem.FileSystem.of({
        ...fs,
        link: (from, to) =>
          to.endsWith(`${path.sep}AGENTS.md`)
            ? fs
                .writeFileString(path.join(skillPath, "SKILL.md"), "Local edit during setup")
                .pipe(Effect.andThen(fs.rename(from, path.join(to, "missing-parent", "file"))))
            : fs.link(from, to),
      });
      const f = yield* fixture.pipe(Effect.provideService(FileSystem.FileSystem, intercepted));
      const skill = ".agents/skills/recovery";
      skillPath = path.join(f.directory, skill);
      yield* fs.makeDirectory(skillPath, { recursive: true });
      yield* fs.writeFileString(path.join(skillPath, "SKILL.md"), "Original local skill");
      const initial: AgentFileSyncBundle = [
        {
          kind: "skill",
          path: skill,
          files: [
            { path: "SKILL.md", data: Buffer.from("Source skill").toString("base64"), mode: 0o600 },
          ],
        },
        ...bundle("Shared"),
      ];
      const error = yield* f.links
        .subscribe({
          sourceEnvironmentId: EnvironmentId.make("source"),
          selection: {
            skills: [skill],
            instructions: [{ path: "AGENTS.md", sectionIds: ["Shared:0"] }],
          },
          label: "Source",
          bundle: initial,
          expected: yield* f.files.preview({ bundle: initial }),
        })
        .pipe(Effect.flip);
      expect(error.reason).toBe("recovery");
      expect(error.message).toContain(error.path);
      expect(yield* fs.readFileString(path.join(skillPath, "SKILL.md"))).toBe(
        "Local edit during setup",
      );
      yield* fs.writeFileString(path.join(skillPath, "SKILL.md"), "Source skill");
      yield* fs.chmod(path.join(skillPath, "SKILL.md"), 0o600);
      expect((yield* f.files.undo({ undoId: error.path! })).failures).toEqual([]);
      expect(yield* fs.readFileString(path.join(skillPath, "SKILL.md"))).toBe(
        "Original local skill",
      );
      expect(yield* f.links.list).toEqual([]);
    }),
  );
  it.effect("recovers from unreadable catalog storage without exposing its cause", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const original = yield* f.subscribe();
      const saved = f.storage.get("agent-file-sync-links");
      const logs: unknown[] = [];
      f.failReads.add("agent-file-sync-links");
      const recovered = yield* f.load.pipe(
        Effect.provide(
          Logger.layer([Logger.make(({ message }) => logs.push(message))], {
            mergeWithExisting: false,
          }),
        ),
      );
      expect(yield* recovered.list).toEqual([]);
      expect(f.storage.get("agent-file-sync-links")).toEqual(saved);
      expect(logs).toHaveLength(1);
      expect(JSON.stringify(logs)).not.toContain("PRIVATE READ ERROR");
      f.failReads.clear();
      expect(yield* (yield* f.load).list).toEqual([original]);
    }),
  );
  it.effect.each(["read", "decode", "baseline"] as const)(
    "preserves saved subscriptions after a %s recovery until a readable restart",
    (failure) =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const original = yield* f.subscribe();
        const catalog = f.storage.get("agent-file-sync-links")!;
        if (failure === "decode") f.storage.set("agent-file-sync-links", Buffer.from("invalid"));
        else
          f.failReads.add(
            failure === "read"
              ? "agent-file-sync-links"
              : [...f.storage.keys()].find((key) => key.startsWith("agent-file-sync-baseline-"))!,
          );
        const recovered = yield* f.load;
        expect(yield* recovered.list).toEqual([]);
        f.failReads.clear();
        const saved = new Map(f.storage);
        const cwd = f.path.join(f.directory, "new-destination");
        yield* f.fs.makeDirectory(cwd);
        const rejected = yield* recovered
          .subscribe({
            cwd,
            sourceEnvironmentId: EnvironmentId.make("new-source"),
            selection: {
              skills: [],
              instructions: [{ path: "AGENTS.md", sectionIds: ["Shared:0"] }],
            },
            label: "New source",
            bundle: bundle("New rules"),
            expected: yield* f.files.preview({ cwd, bundle: bundle("New rules") }),
          })
          .pipe(Effect.result);
        expect(rejected).toMatchObject({
          _tag: "Failure",
          failure: { reason: "unreadable-state" },
        });
        expect(f.storage).toEqual(saved);
        expect(yield* f.fs.exists(f.path.join(cwd, "AGENTS.md"))).toBe(false);
        f.storage.set("agent-file-sync-links", catalog);
        const restarted = yield* f.load;
        expect(yield* restarted.list).toEqual([original]);
        yield* restarted.manage({ id: original.id, action: "pause" });
        expect((yield* restarted.list)[0]?.paused).toBe(true);
      }),
  );
  it.effect("blocks management and refresh when only part of the catalog could be loaded", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const first = yield* f.subscribe();
      const baseline = [...f.storage.keys()].find((key) =>
        key.startsWith("agent-file-sync-baseline-"),
      )!;
      const cwd = f.path.join(f.directory, "other");
      yield* f.fs.makeDirectory(cwd);
      yield* f.links.subscribe({
        cwd,
        sourceEnvironmentId: EnvironmentId.make("other-source"),
        selection: { skills: [], instructions: [{ path: "AGENTS.md", sectionIds: ["Shared:0"] }] },
        label: "Other source",
        bundle: bundle("Other rules"),
        expected: yield* f.files.preview({ cwd, bundle: bundle("Other rules") }),
      });
      const other = (yield* f.links.list)[1]!;
      const saved = new Map(f.storage);
      const text = yield* f.fs.readFileString(f.path.join(cwd, "AGENTS.md"));
      f.failReads.add(baseline);
      const recovered = yield* f.load;
      expect(yield* recovered.list).toEqual([other]);
      f.failReads.clear();
      expect(
        yield* recovered.manage({ id: other.id, action: "pause" }).pipe(Effect.result),
      ).toMatchObject({
        _tag: "Failure",
        failure: { reason: "unreadable-state" },
      });
      expect(
        yield* recovered
          .refresh({ id: other.id, generation: other.generation, bundle: bundle("Changed") })
          .pipe(Effect.result),
      ).toMatchObject({ _tag: "Failure", failure: { reason: "unreadable-state" } });
      expect(f.storage).toEqual(saved);
      expect(yield* f.fs.readFileString(f.path.join(cwd, "AGENTS.md"))).toBe(text);
      expect(yield* (yield* f.load).list).toEqual([first, other]);
    }),
  );
  it.effect("persists preview failures as a visible paused subscription", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const link = yield* f.subscribe();
      const original = yield* f.fs.readFileString(f.path.join(f.directory, "AGENTS.md"));
      yield* f.fs.remove(f.path.join(f.directory, "AGENTS.md"), { recursive: true });
      yield* f.fs.makeDirectory(f.path.join(f.directory, "AGENTS.md"));
      const error = yield* f.links
        .refresh({ id: link.id, generation: 0, bundle: bundle("Updated") })
        .pipe(Effect.flip);
      expect(error.reason).toBe("linked-destination");
      const paused = (yield* f.links.list)[0]!;
      expect(paused).toMatchObject({ paused: true, error: error.message, generation: 1 });
      expect(yield* (yield* f.load).list).toEqual([paused]);
      yield* f.fs.remove(f.path.join(f.directory, "AGENTS.md"), { recursive: true });
      yield* f.fs.writeFileString(f.path.join(f.directory, "AGENTS.md"), original);
      yield* f.fs.chmod(f.path.join(f.directory, "AGENTS.md"), 0o600);
      yield* f.links.manage({ id: link.id, action: "resume" });
      yield* f.links.refresh({ id: link.id, generation: 2, bundle: bundle("Updated") });
      expect((yield* f.links.list)[0]?.paused).toBe(false);
      expect(yield* f.fs.readFileString(f.path.join(f.directory, "AGENTS.md"))).toContain(
        "Updated",
      );
    }),
  );
  it.effect.each(["skill-first", "instructions-first"] as const)(
    "rejects subscriptions inside an owned skill directory (%s)",
    (order) =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const skillPath = ".agents/skills/owned";
        const cwd = f.path.join(f.directory, skillPath);
        yield* f.fs.makeDirectory(cwd, { recursive: true });
        yield* f.fs.writeFileString(f.path.join(cwd, "SKILL.md"), "Local skill");
        const skill: AgentFileSyncBundle = [
          {
            kind: "skill",
            path: skillPath,
            files: [
              { path: "SKILL.md", data: Buffer.from("Skill").toString("base64"), mode: 0o600 },
              {
                path: "AGENTS.md",
                data: Buffer.from("Skill instructions").toString("base64"),
                mode: 0o600,
              },
            ],
          },
        ];
        const instructions = bundle("Nested instructions");
        const subscribeSkill = Effect.gen(function* () {
          yield* f.links.subscribe({
            sourceEnvironmentId: EnvironmentId.make("source"),
            selection: { skills: [skillPath], instructions: [] },
            label: "Skill",
            bundle: skill,
            expected: yield* f.files.preview({ bundle: skill }),
          });
        });
        const subscribeInstructions = Effect.gen(function* () {
          yield* f.links.subscribe({
            cwd,
            sourceEnvironmentId: EnvironmentId.make("source"),
            selection: {
              skills: [],
              instructions: [{ path: "AGENTS.md", sectionIds: ["Shared:0"] }],
            },
            label: "Instructions",
            bundle: instructions,
            expected: yield* f.files.preview({ cwd, bundle: instructions }),
          });
        });
        yield* order === "skill-first" ? subscribeSkill : subscribeInstructions;
        const contents = yield* f.fs.readFileString(f.path.join(cwd, "AGENTS.md"));
        expect(
          (yield* (order === "skill-first" ? subscribeInstructions : subscribeSkill).pipe(
            Effect.flip,
          )).reason,
        ).toBe("overlap");
        expect(yield* f.fs.readFileString(f.path.join(cwd, "AGENTS.md"))).toBe(contents);
        expect(yield* f.links.list).toHaveLength(1);
        const sibling = `${cwd}-sibling`;
        yield* f.fs.makeDirectory(sibling);
        yield* f.links.subscribe({
          cwd: sibling,
          sourceEnvironmentId: EnvironmentId.make("source"),
          selection: {
            skills: [],
            instructions: [{ path: "AGENTS.md", sectionIds: ["Shared:0"] }],
          },
          label: "Sibling",
          bundle: instructions,
          expected: yield* f.files.preview({ cwd: sibling, bundle: instructions }),
        });
        expect(yield* f.links.list).toHaveLength(2);
      }),
  );
  it.effect("rolls back new Windows instruction files when subscription publication fails", () =>
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
      f.failWrites.add("agent-file-sync-links");
      expect((yield* f.subscribe().pipe(Effect.flip)).reason).toBe("io");
      expect(yield* fs.exists(f.path.join(f.directory, "AGENTS.md"))).toBe(false);
      expect(yield* f.links.list).toEqual([]);
    }),
  );
});
