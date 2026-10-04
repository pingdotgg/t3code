import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  type ContributionStatusSnapshot,
  contributionStatusSourceKey,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";

import * as ContributionStatusStore from "@t3tools/provider-core/server/ContributionStatusStore";
import { loadPluginDirectory, type PluginRegistration } from "./PluginManifestLoader.ts";
import * as PluginStatus from "./PluginStatus.ts";
import * as PluginSupervisor from "./PluginSupervisor.ts";
import { recordingSupervisor, registrationFor } from "./testFixtures/hostCalls.ts";

const ManifestJson = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown));
const decodeManifestJson = Schema.decodeUnknownEffect(ManifestJson);
const encodeManifestJson = Schema.encodeEffect(ManifestJson);

const FIXTURE_DIR = `${import.meta.dirname}/testFixtures/statusPlugin`;
// Children run the real CLI entry, which routes `__plugin-host` to the child runtime.
const BIN_PATH = `${import.meta.dirname}/../bin.ts`;
const THREAD_A = ThreadId.make("thread-a");
const THREAD_B = ThreadId.make("thread-b");

/** `thread: [source key, ...item texts]` per entry, in snapshot order. */
const shown = (snapshot: ContributionStatusSnapshot) =>
  snapshot.entries.map(
    (entry) =>
      `${entry.threadId}: ${[contributionStatusSourceKey(entry.source), ...entry.items.map((item) => `${item.key}=${item.text}`)].join(" ")}`,
  );

const start = Effect.fn("start")(function* () {
  const store = yield* ContributionStatusStore.make();
  const { supervisor, call } = recordingSupervisor();
  yield* PluginStatus.make().pipe(
    Effect.provideService(PluginSupervisor.PluginSupervisor, supervisor),
    Effect.provideService(ContributionStatusStore.ContributionStatusStore, store),
  );
  const set = (registration: PluginRegistration, lifetime: Scope.Scope, input: Schema.Json) =>
    call("status.set", registration, lifetime, input);
  const clear = (registration: PluginRegistration, lifetime: Scope.Scope, input: Schema.Json) =>
    call("status.clear", registration, lifetime, input);
  return { store, set, clear };
});

it.layer(NodeServices.layer)("PluginStatus", (it) => {
  describe("host methods", () => {
    it.effect("shows each plugin beside the provider and clears it when its process ends", () =>
      Effect.gen(function* () {
        const { store, set, clear } = yield* start();
        const provider = yield* store.openSource({
          kind: "provider-session",
          providerSessionId: ProviderSessionId.make("session-1"),
          providerInstanceId: ProviderInstanceId.make("pi"),
          driver: ProviderDriverKind.make("pi"),
        });
        yield* provider.bindThread(THREAD_A);
        yield* provider.set({ key: "mode", text: "plan" });

        const a = registrationFor("acme.a");
        const b = registrationFor("acme.b");
        const lifetimeA = yield* Scope.make();
        const lifetimeB = yield* Scope.make();
        yield* set(a, lifetimeA, {
          threadId: THREAD_A,
          key: "ci",
          text: "passing",
          tone: "success",
        });
        yield* set(a, lifetimeA, { threadId: THREAD_B, key: "ci", text: "failing" });
        yield* set(b, lifetimeB, { threadId: THREAD_A, key: "ci", text: "b's own" });
        assert.deepStrictEqual(shown(yield* store.snapshot), [
          'thread-a: ["provider-session","pi","session-1"] mode=plan',
          'thread-a: ["plugin","acme.a"] ci=passing',
          'thread-a: ["plugin","acme.b"] ci=b\'s own',
          'thread-b: ["plugin","acme.a"] ci=failing',
        ]);
        const pluginEntry = (yield* store.snapshot).entries[1];
        assert.deepStrictEqual(pluginEntry?.source, {
          kind: "plugin",
          pluginId: "acme.a",
          name: "Plugin acme.a",
        });
        assert.deepStrictEqual(pluginEntry?.items, [
          { key: "ci", text: "passing", tone: "success" },
        ]);

        yield* clear(a, lifetimeA, { threadId: THREAD_B, key: "ci" });
        yield* Scope.close(lifetimeB, Exit.void);
        assert.deepStrictEqual(shown(yield* store.snapshot), [
          'thread-a: ["provider-session","pi","session-1"] mode=plan',
          'thread-a: ["plugin","acme.a"] ci=passing',
        ]);

        yield* Scope.close(lifetimeA, Exit.void);
        assert.deepStrictEqual(shown(yield* store.snapshot), [
          'thread-a: ["provider-session","pi","session-1"] mode=plan',
        ]);
        const late = yield* set(a, lifetimeA, { threadId: THREAD_A, key: "ci", text: "x" }).pipe(
          Effect.flip,
        );
        assert.strictEqual(late.message, "The plugin was stopped.");
        assert.lengthOf((yield* store.snapshot).entries, 1);
      }).pipe(Effect.scoped),
    );

    it.effect("bounds a process to 16 statuses and rate-limits sets but not clears", () =>
      Effect.gen(function* () {
        const { store, set, clear } = yield* start();
        const plugin = registrationFor("acme.busy");
        const lifetime = yield* Scope.make();
        for (let index = 0; index < 10; index++)
          yield* set(plugin, lifetime, {
            threadId: THREAD_A,
            key: `k${index % 8}`,
            text: `${index}`,
          });
        const limited = yield* set(plugin, lifetime, {
          threadId: THREAD_B,
          key: "k0",
          text: "x",
        }).pipe(Effect.flip);
        assert.include(limited.message, "Too many status updates");
        // Clearing is never limited.
        yield* clear(plugin, lifetime, { threadId: THREAD_A, key: "k7" });

        yield* TestClock.adjust("500 millis");
        yield* set(plugin, lifetime, { threadId: THREAD_A, key: "k7", text: "back" });
        for (let index = 0; index < 8; index++) {
          yield* TestClock.adjust("500 millis");
          yield* set(plugin, lifetime, { threadId: THREAD_B, key: `k${index}`, text: "b" });
        }
        yield* TestClock.adjust("500 millis");
        const full = yield* set(plugin, lifetime, {
          threadId: ThreadId.make("thread-c"),
          key: "k0",
          text: "x",
        }).pipe(Effect.flip);
        assert.include(full.message, "at most 16 statuses");
        // Replacing a shown key is fine, and empty text frees a slot.
        yield* set(plugin, lifetime, { threadId: THREAD_A, key: "k0", text: "replaced" });
        yield* TestClock.adjust("500 millis");
        yield* set(plugin, lifetime, { threadId: THREAD_A, key: "k1", text: "  " });
        yield* TestClock.adjust("500 millis");
        yield* set(plugin, lifetime, { threadId: ThreadId.make("thread-c"), key: "k0", text: "c" });
        const counts = (yield* store.snapshot).entries.map(
          (entry) => `${entry.threadId}:${entry.items.length}`,
        );
        assert.deepStrictEqual(counts, ["thread-a:7", "thread-b:8", "thread-c:1"]);
      }).pipe(Effect.scoped),
    );

    it.effect("refuses undeclared capability and malformed input", () =>
      Effect.gen(function* () {
        const { store, set, clear } = yield* start();
        const lifetime = yield* Scope.make();
        const plugin = registrationFor("acme.p");
        const undeclared = yield* set(registrationFor("acme.q", ["events"]), lifetime, {
          threadId: THREAD_A,
          key: "k",
          text: "x",
        }).pipe(Effect.flip);
        assert.strictEqual(
          undeclared.message,
          'The plugin did not declare the "status" capability.',
        );
        for (const input of [
          { threadId: THREAD_A, key: "k" },
          { threadId: THREAD_A, key: "k", text: "x", tone: "loud" },
          { threadId: "", key: "k", text: "x" },
        ]) {
          assert.include((yield* set(plugin, lifetime, input).pipe(Effect.flip)).message, "status");
        }
        for (const key of ["", "x".repeat(65), "a\nb"]) {
          const error = yield* set(plugin, lifetime, { threadId: THREAD_A, key, text: "x" }).pipe(
            Effect.flip,
          );
          assert.include(error.message, "Status keys");
          assert.include(
            (yield* clear(plugin, lifetime, { threadId: THREAD_A, key }).pipe(Effect.flip)).message,
            "Status keys",
          );
        }
        assert.deepStrictEqual((yield* store.snapshot).entries, []);
      }).pipe(Effect.scoped),
    );
  });

  describe("manifest", () => {
    it.effect("loads statuses only with the proposed API opt-in", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-plugin-status-" });
        yield* fs.copyFile(path.join(FIXTURE_DIR, "main.mjs"), path.join(directory, "main.mjs"));
        const manifest = yield* decodeManifestJson(
          yield* fs.readFileString(path.join(FIXTURE_DIR, "t3-plugin.json")),
        );
        for (const capability of ["status"]) {
          yield* fs.writeFileString(
            path.join(directory, "t3-plugin.json"),
            yield* encodeManifestJson({
              ...manifest,
              capabilities: [capability],
              proposedApi: false,
            }),
          );
          const error = yield* loadPluginDirectory(directory).pipe(Effect.flip);
          assert.include(error.reason, `"${capability}" capability needs "proposedApi": true`);
        }
        const loaded = yield* loadPluginDirectory(FIXTURE_DIR);
        assert.deepStrictEqual(loaded.manifest.capabilities, ["status"]);
      }).pipe(Effect.scoped),
    );
  });

  describe("with a real plugin process", () => {
    it.effect("clears statuses on disable and on a crash", () =>
      Effect.gen(function* () {
        const store = yield* ContributionStatusStore.make();
        const supervisor = yield* PluginSupervisor.make({
          heapLimitMb: 64,
          activationTimeout: "10 seconds",
          stopGrace: "1 second",
        }).pipe(Effect.provideService(HostProcess.Arguments, [process.execPath, BIN_PATH]));
        yield* PluginStatus.make().pipe(
          Effect.provideService(PluginSupervisor.PluginSupervisor, supervisor),
          Effect.provideService(ContributionStatusStore.ContributionStatusStore, store),
        );
        const registration = yield* loadPluginDirectory(FIXTURE_DIR);
        const pluginId = registration.manifest.id;

        const showStatus = Effect.fn("showStatus")(function* (text: string) {
          yield* supervisor.invoke(pluginId, "status", { threadId: THREAD_A, key: "run", text });
          assert.deepStrictEqual(shown(yield* store.snapshot), [
            `thread-a: ["plugin","test.status"] run=${text}`,
          ]);
        });

        yield* supervisor.enable(registration);
        yield* showStatus("first run");
        // Disable returns after the process's host work, and so its statuses, have ended.
        yield* supervisor.disable(pluginId);
        assert.deepStrictEqual((yield* store.snapshot).entries, []);

        yield* supervisor.enable(registration);
        yield* showStatus("second run");
        const crash = yield* supervisor.invoke(pluginId, "crash", null).pipe(Effect.flip);
        assert.strictEqual(crash._tag, "PluginCrashedError");
        // A dead process's host work ends before its callers learn of the crash.
        assert.deepStrictEqual((yield* store.snapshot).entries, []);
      }).pipe(Effect.scoped),
    );
  });
});
