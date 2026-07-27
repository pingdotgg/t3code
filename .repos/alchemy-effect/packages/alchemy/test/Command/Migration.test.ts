import * as Command from "@/Command";
import { Stack } from "@/Stack";
import { type ResourceState, State } from "@/State";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as pathe from "pathe";

const { test } = Test.make({ providers: Command.providers(), dev: true });

const FIXTURE_DIR = pathe.resolve(import.meta.dirname, "fixture");

const makeTemporaryFixture = Effect.fn(function* () {
  const fs = yield* FileSystem.FileSystem;
  const tempDir = yield* fs.makeTempDirectoryScoped();
  yield* fs.copy(FIXTURE_DIR, tempDir);
  return { cwd: tempDir, outdir: pathe.join(tempDir, "dist") };
});

// Seed a resource row directly into the scratch stack's shared in-memory state,
// simulating state written by an older provider version. Both the test body and
// the deploys driven through `stack` read/write the same store keyed by
// (stack, stage, fqn).
const seedLegacyState = Effect.fn(function* (
  fqn: string,
  value: ResourceState,
) {
  const state = yield* yield* State;
  const stk = yield* Stack;
  yield* state.set({ stack: stk.name, stage: stk.stage, fqn, value });
});

const getState = Effect.fn(function* (fqn: string) {
  const state = yield* yield* State;
  const stk = yield* Stack;
  return (yield* state.get({ stack: stk.name, stage: stk.stage, fqn })) as
    | ResourceState
    | undefined;
});

// ─────────────────────────────────────────────────────────────────────
// Build.Command → Command.Build
//
// `Build.Command` was renamed to `Command.Build` and its `attr.hash` shape
// changed from a bare `string` to `{ input, output }`. Deploying the renamed
// resource over the old state must not error — it may re-run the build (the
// memoization logic changed), but it must converge.
// ─────────────────────────────────────────────────────────────────────
test.provider(
  "Command.Build deploys over legacy Build.Command state without error",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const fixture = yield* makeTemporaryFixture();

      // Mirror `examples/.../Website__Build.json`: old resourceType and the
      // legacy `attr.hash` string (pre-`{ input, output }`).
      yield* seedLegacyState("test-build", {
        status: "created",
        fqn: "test-build",
        logicalId: "test-build",
        instanceId: "606bcaf4c0a931156f5a314ba7b57fc3",
        resourceType: "Build.Command",
        props: { command: "bash build.sh", outdir: "dist", env: {} },
        attr: {
          outdir: "dist",
          hash: "a41cbcecfdeb355f6f98130ca4ff8269d0ad5cc3a628f1918d956c71f859648c",
        },
        bindings: [],
        providerVersion: 0,
        downstream: [],
        removalPolicy: "destroy",
        namespace: undefined,
      });

      const build = yield* stack.deploy(
        Command.Build("test-build", {
          command: "bash build.sh",
          shell: true,
          cwd: fixture.cwd,
          outdir: "dist",
        }),
      );

      // The build re-ran and produced the new attribute shape.
      expect(pathe.resolve(build.outdir)).toBe(fixture.outdir);
      expect(build.hash).toMatchObject({
        input: expect.any(String),
        output: expect.any(String),
      });

      // State is migrated to the new resource type.
      const migrated = yield* getState("test-build");
      expect(migrated?.resourceType).toBe("Command.Build");

      yield* stack.destroy();
    }),
  { timeout: 60000 },
);

// ─────────────────────────────────────────────────────────────────────
// Build.DevServer → Command.Dev
//
// `Build.DevServer` was renamed to `Command.Dev`. Deploying the renamed
// resource (in dev mode) over the old state must spawn the new dev process and
// converge — re-extracting a fresh URL rather than carrying the stale one.
// ─────────────────────────────────────────────────────────────────────
test.provider(
  "Command.Dev deploys over legacy Build.DevServer state without error",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Mirror `examples/.../Website__Dev.json`, including the stale URL.
      yield* seedLegacyState("test-dev", {
        status: "created",
        fqn: "test-dev",
        logicalId: "test-dev",
        instanceId: "b4ca740550ef6e2e409481cedf9314c7",
        resourceType: "Build.DevServer",
        props: { command: "zola serve", env: {} },
        attr: { url: "http://127.0.0.1:1024" },
        bindings: [],
        providerVersion: 0,
        downstream: [],
        removalPolicy: "destroy",
        namespace: undefined,
      });

      // A dev server must stay alive (the provider treats an early exit as an
      // error), so print a URL and then block. `stack.destroy()` interrupts it.
      const dev = yield* stack.deploy(
        Command.Dev("test-dev", {
          command: "echo http://127.0.0.1:4321 && sleep 600",
          shell: true,
        }),
      );

      // The new provider ran: it re-extracted the URL the spawned process
      // printed rather than echoing back the stale seeded attribute.
      expect(dev.url).toBe("http://127.0.0.1:4321");

      const migrated = yield* getState("test-dev");
      expect(migrated?.resourceType).toBe("Command.Dev");

      yield* stack.destroy();
    }),
  { timeout: 60000 },
);

// ─────────────────────────────────────────────────────────────────────
// Orphaned legacy resource cleanup
//
// When a `Build.Command` / `Build.DevServer` row lingers in state but is no
// longer declared, the engine resolves the old type to the `Renamed` no-op
// provider and deletes the row. This must not error.
// ─────────────────────────────────────────────────────────────────────
test.provider(
  "destroy removes an orphaned legacy Build.Command via the renamed provider",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      yield* seedLegacyState("orphan-build", {
        status: "created",
        fqn: "orphan-build",
        logicalId: "orphan-build",
        instanceId: "606bcaf4c0a931156f5a314ba7b57fc3",
        resourceType: "Build.Command",
        props: { command: "zola build", outdir: "public", env: {} },
        attr: {
          outdir: "public",
          hash: "a41cbcecfdeb355f6f98130ca4ff8269d0ad5cc3a628f1918d956c71f859648c",
        },
        bindings: [],
        providerVersion: 0,
        downstream: [],
        removalPolicy: "destroy",
        namespace: undefined,
      });

      expect(yield* getState("orphan-build")).toBeDefined();

      // An empty-plan apply (destroy) reaps the orphan through the renamed
      // provider's no-op delete.
      yield* stack.destroy();

      expect(yield* getState("orphan-build")).toBeUndefined();
    }),
  { timeout: 60000 },
);
