import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Profiles from "./Profiles.ts";
import * as ProfilesStore from "./ProfilesStore.ts";
import * as ProfilesCommandRunner from "./ProfilesCommandRunner.ts";

it.effect(
  "serializes editor and sync revisions, protects conflicts and excluded files, and backs up local edits",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      yield* Effect.gen(function* () {
        const store = yield* ProfilesStore.ProfilesStore;
        const initial = yield* store.read();
        assert.isFalse(initial.exists);
        const first = yield* store.write({
          expectedRevision: initial.sync.revision,
          profiles: { profiles: { coding: { prompts: ["coding"], skills: [] } } },
          prompts: { upsert: [{ name: "coding", content: "original" }] },
          mcpServers: { mcpServers: { docs: { type: "http", url: "https://docs.example/mcp" } } },
        });
        assert.equal(first.sync.revision, initial.sync.revision + 1);
        assert.deepEqual(first.mcpServers, {
          mcpServers: { docs: { type: "http", url: "https://docs.example/mcp" } },
        });
        const outcomes = yield* Effect.all(
          [
            store
              .write({
                expectedRevision: first.sync.revision,
                prompts: { upsert: [{ name: "coding", content: "original" }] },
              })
              .pipe(Effect.result),
            store
              .write({ expectedRevision: first.sync.revision, prompts: { remove: ["coding"] } })
              .pipe(Effect.result),
          ],
          { concurrency: "unbounded" },
        );
        assert.equal(outcomes.filter((result) => result._tag === "Success").length, 1);
        const saved = yield* store.read();
        assert.equal(saved.sync.revision, first.sync.revision + 1);
        yield* fs.writeFileString(`${root}/profiles/run.sh`, "#!/bin/sh\nexit 0\n");
        yield* fs.chmod(`${root}/profiles/run.sh`, 0o755);
        yield* fs.makeDirectory(`${root}/profiles/.git`, { recursive: true });
        yield* fs.writeFileString(`${root}/profiles/.git/keep`, "private");
        yield* fs.writeFileString(`${root}/profiles/oversized`, "x".repeat(1024 * 1024 + 1));
        const bundle = yield* store.syncRead({ includeFiles: true });
        assert.include(bundle.skipped!, "oversized");
        assert.include(bundle.skipped!, ".git");
        assert.isTrue(bundle.files!.find((file) => file.path === "run.sh")?.executable);
        // Windows cannot report executable bits, so they must not change the hash.
        yield* fs.chmod(`${root}/profiles/run.sh`, 0o644);
        assert.equal(
          (yield* store.syncRead({ includeFiles: false })).state.hash,
          bundle.state.hash,
        );
        yield* fs.chmod(`${root}/profiles/run.sh`, 0o755);
        yield* store.syncMark({ hash: bundle.state.hash });
        yield* fs.writeFileString(`${root}/profiles/prompts/coding.md`, "outside edit");
        yield* fs.writeFileString(`${root}/profiles/stale.txt`, "old");
        yield* fs.makeDirectory(`${root}/profiles/node_modules`, { recursive: true });
        yield* fs.writeFileString(`${root}/profiles/node_modules/keep`, "keep");
        // An edit made outside T3 is dated by its file, not by when T3 notices it.
        const editedAt = DateTime.toDateUtc(DateTime.makeUnsafe("2030-01-01T00:00:00.000Z"));
        yield* fs.utimes(`${root}/profiles/prompts/coding.md`, editedAt, editedAt);
        const changed = yield* store.syncRead({ includeFiles: true });
        assert.equal(changed.state.revision, bundle.state.revision + 1);
        assert.equal(changed.state.updatedAt, "2030-01-01T00:00:00.000Z");
        assert.isTrue(changed.enabled);
        assert.equal(
          (yield* store
            .write({ expectedRevision: first.sync.revision, prompts: { remove: ["coding"] } })
            .pipe(Effect.flip)).reason,
          "conflict",
        );
        assert.equal(
          (yield* store
            .syncWrite({
              expectedRevision: first.sync.revision,
              source: bundle.state,
              files: bundle.files!,
            })
            .pipe(Effect.flip)).reason,
          "conflict",
        );
        for (const path of [
          "../escape",
          "/absolute",
          "a/../b",
          "a\\b",
          "a//b",
          ".git/config",
          "a/node_modules/file",
          ".t3-sync.json",
        ]) {
          assert.equal(
            (yield* store
              .syncWrite({
                expectedRevision: changed.state.revision,
                source: bundle.state,
                files: [{ path, contentBase64: "YQ==" }],
              })
              .pipe(Effect.flip)).reason,
            "invalid",
          );
        }
        assert.equal(
          (yield* store
            .syncWrite({
              expectedRevision: changed.state.revision,
              source: { ...bundle.state, hash: "wrong" },
              files: bundle.files!,
            })
            .pipe(Effect.flip)).reason,
          "invalid",
        );
        assert.equal(
          yield* fs.readFileString(`${root}/profiles/prompts/coding.md`),
          "outside edit",
        );
        const synced = yield* store.syncWrite({
          expectedRevision: changed.state.revision,
          source: bundle.state,
          files: bundle.files!,
        });
        assert.isDefined(synced.backupPath);
        assert.equal(
          yield* fs.readFileString(`${synced.backupPath}/prompts/coding.md`),
          "outside edit",
        );
        assert.equal(yield* fs.readFileString(`${root}/profiles/prompts/coding.md`), "original");
        assert.notEqual((yield* fs.stat(`${root}/profiles/run.sh`)).mode & 0o111, 0);
        assert.equal(yield* fs.readFileString(`${root}/profiles/.git/keep`), "private");
        assert.isTrue(yield* fs.exists(`${root}/profiles/oversized`));
        assert.isFalse(yield* fs.exists(`${root}/profiles/stale.txt`));
        assert.equal(yield* fs.readFileString(`${root}/profiles/node_modules/keep`), "keep");
        assert.equal(synced.state.syncedHash, bundle.state.hash);
        // A copy counts as a change here but keeps the time its content last changed.
        assert.deepEqual(yield* store.syncRead({ includeFiles: false }), {
          state: synced.state,
          enabled: true,
          skipped: changed.skipped!,
        });
        assert.equal(synced.state.revision, changed.state.revision + 1);
        assert.equal(synced.state.updatedAt, bundle.state.updatedAt);
        const tied = yield* store.syncWrite({
          expectedRevision: synced.state.revision,
          source: { hash: changed.state.hash, updatedAt: changed.state.updatedAt },
          files: changed.files!,
        });
        assert.equal(tied.state.revision, synced.state.revision + 1);
        assert.equal(
          (yield* store
            .write({
              expectedRevision: synced.state.revision,
              expectedHash: synced.state.hash,
              prompts: { upsert: [{ name: "coding", content: "stale editor" }] },
            })
            .pipe(Effect.flip)).reason,
          "conflict",
        );
        assert.equal(
          (yield* store
            .syncWrite({
              expectedRevision: synced.state.revision,
              expectedHash: synced.state.hash,
              source: bundle.state,
              files: bundle.files!,
            })
            .pipe(Effect.flip)).reason,
          "conflict",
        );
        yield* store.syncWrite({
          expectedRevision: tied.state.revision,
          expectedHash: tied.state.hash,
          source: bundle.state,
          files: bundle.files!,
        });
        yield* fs.symlink(`${root}/profiles/prompts`, `${root}/profiles/link`);
        const linked = yield* store.syncRead({ includeFiles: true });
        assert.include(linked.skipped!, "link");
        assert.equal(
          (yield* store
            .write({
              expectedRevision: linked.state.revision,
              prompts: { upsert: [{ name: "coding", content: "x".repeat(1024 * 1024 + 1) }] },
            })
            .pipe(Effect.flip)).reason,
          "invalid",
        );
        assert.equal(yield* fs.readFileString(`${root}/profiles/prompts/coding.md`), "original");
        yield* fs.writeFileString(`${root}/profiles/profiles.json`, "broken json");
        const broken = yield* store.read();
        assert.isNull(broken.profiles);
        assert.isDefined(broken.error);
        for (let i = 0; i < 9; i++)
          yield* fs.writeFileString(`${root}/profiles/large-${i}`, "x".repeat(1024 * 1024));
        assert.equal(
          (yield* store.syncRead({ includeFiles: true }).pipe(Effect.flip)).reason,
          "invalid",
        );
      }).pipe(
        Effect.provide(
          ProfilesStore.layer.pipe(
            Layer.provide([
              Profiles.layer,
              ServerSettings.layerTest(),
              ServerConfig.layerTest(root, root),
              Layer.succeed(ProfilesCommandRunner.ProfilesCommandRunner, {
                run: () => Effect.succeed("ok"),
              }),
            ]),
          ),
        ),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("neither sends nor receives profile copies while sync is off", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped();
    yield* fs.makeDirectory(`${root}/profiles`, { recursive: true });
    yield* fs.writeFileString(`${root}/profiles/profiles.json`, '{"profiles":{}}');
    yield* Effect.gen(function* () {
      const store = yield* ProfilesStore.ProfilesStore;
      const read = yield* store.syncRead({ includeFiles: false });
      assert.isFalse(read.enabled);
      assert.equal(
        (yield* store.syncRead({ includeFiles: true }).pipe(Effect.flip)).reason,
        "unavailable",
      );
      assert.equal(
        (yield* store
          .syncWrite({
            expectedRevision: read.state.revision,
            source: { hash: read.state.hash, updatedAt: null },
            files: [],
          })
          .pipe(Effect.flip)).reason,
        "unavailable",
      );
      assert.equal(yield* fs.readFileString(`${root}/profiles/profiles.json`), '{"profiles":{}}');
    }).pipe(
      Effect.provide(
        ProfilesStore.layer.pipe(
          Layer.provide([
            Profiles.layer,
            ServerSettings.layerTest({ profilesSync: false }),
            ServerConfig.layerTest(root, root),
            Layer.succeed(ProfilesCommandRunner.ProfilesCommandRunner, {
              run: () => Effect.succeed("ok"),
            }),
          ]),
        ),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect(
  "runs validated skill operations with closed-runner arguments and records every command revision",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const commands: Array<{ command: string; args: readonly string[]; cwd: string }> = [];
      yield* fs.makeDirectory(`${root}/profiles/.agents/skills/review`, { recursive: true });
      yield* fs.writeFileString(`${root}/profiles/.agents/skills/review/package.json`, "{}");
      yield* fs.writeFileString(
        `${root}/profiles/.agents/skills/review/SKILL.md`,
        "---\nname: review\ndescription: Review changes\n---\n",
      );
      yield* fs.writeFileString(
        `${root}/profiles/skills-lock.json`,
        JSON.stringify({ skills: { review: { source: "owner/repo" } } }),
      );
      yield* Effect.gen(function* () {
        const store = yield* ProfilesStore.ProfilesStore;
        const initial = yield* store.read();
        assert.equal(initial.skills[0]?.source, "owner/repo");
        assert.isTrue(initial.skills[0]?.needsInstall);
        yield* store.skills({ _tag: "add", source: "owner/repo", skill: "review" });
        yield* store.skills({ _tag: "update" });
        yield* store.skills({ _tag: "remove", name: "review" });
        yield* store.skills({ _tag: "install", name: "review" });
        assert.deepEqual(commands, [
          {
            command: "npx",
            args: [
              "-y",
              "skills@1",
              "add",
              "owner/repo",
              "-s",
              "review",
              "-a",
              "codex",
              "-y",
              "--copy",
            ],
            cwd: `${root}/profiles`,
          },
          {
            command: "npx",
            args: ["-y", "skills@1", "update", "-p", "-y"],
            cwd: `${root}/profiles`,
          },
          {
            command: "npx",
            args: ["-y", "skills@1", "remove", "review", "-a", "codex", "-y"],
            cwd: `${root}/profiles`,
          },
          {
            command: "npm",
            args: ["install", "--omit=dev", "--no-audit", "--no-fund"],
            cwd: `${root}/profiles/.agents/skills/review`,
          },
        ]);
        assert.equal((yield* store.read()).sync.revision, initial.sync.revision + 4);
      }).pipe(
        Effect.provide(
          ProfilesStore.layer.pipe(
            Layer.provide([
              Profiles.layer,
              ServerSettings.layerTest(),
              ServerConfig.layerTest(root, root),
              Layer.succeed(ProfilesCommandRunner.ProfilesCommandRunner, {
                run: (input) =>
                  Effect.sync(() => {
                    commands.push(input);
                    return "ok";
                  }),
              }),
            ]),
          ),
        ),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);
