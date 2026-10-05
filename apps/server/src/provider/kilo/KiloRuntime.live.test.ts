// @effect-diagnostics nodeBuiltinImport:off - real owner crash fixture.
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeURL from "node:url";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProviderInstanceId, ProviderSessionId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import { describe } from "vite-plus/test";

import * as KiloRuntime from "./KiloRuntime.ts";
import { KiloDriver } from "../Drivers/KiloDriver.ts";
import * as ServerConfig from "../../config.ts";
import * as IdAllocator from "../../orchestration-v2/IdAllocator.ts";

const binary = process.env.KILO_BIN;
const platform = HostProcessPlatform.defaultValue();
const decodeGroup = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ pgid: Schema.Number })),
);
const decodeOwner = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({ owner: Schema.Struct({ pid: Schema.Number }), pgid: Schema.Number }),
  ),
);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const environment = {
  PATH: process.env.PATH,
  // Fixtures import only Node builtins; do not let optional plugin package setup
  // reach the registry or inherit an external npm configuration from HOME.
  npm_config_offline: "true",
  HTTP_PROXY: process.env.HTTP_PROXY,
  HTTPS_PROXY: process.env.HTTPS_PROXY,
  NO_PROXY: process.env.NO_PROXY,
  NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS,
  KILO_DISABLE_MODELS_FETCH: "1",
  KILO_DISABLE_DEFAULT_PLUGINS: "1",
  KILO_DISABLE_EXTERNAL_SKILLS: "1",
  KILO_DISABLE_PROJECT_CONFIG: "1",
};

describe.skipIf(!binary)("KiloRuntime native lifecycle", () => {
  it.live(
    "loads explicitly trusted repository and external plugins before tool approvals",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-kilo-plugin-" });
        const cwd = path.join(root, "checkout");
        const pluginDir = path.join(cwd, ".kilo", "plugins");
        yield* fs.makeDirectory(pluginDir, { recursive: true });
        const marker = path.join(root, "repository-plugin-ran");
        const explicitMarker = path.join(root, "explicit-plugin-ran");
        const body = (target: string) =>
          `import { writeFileSync } from "node:fs";\nimport { spawn } from "node:child_process";\nconst child = spawn(${encodeJson(process.execPath)}, ["-e", "setInterval(()=>{},1000)"], {stdio:"ignore"});\nwriteFileSync(${encodeJson(target)}, String(child.pid));\nexport const fixture = async () => ({});\n`;
        yield* fs.writeFileString(path.join(pluginDir, "unsafe.ts"), body(marker));
        const explicitPlugin = path.join(root, "explicit.ts");
        yield* fs.writeFileString(explicitPlugin, body(explicitMarker));
        // Native configuration is explicitly trusted, independently of tool approvals.
        const runtime = yield* KiloRuntime.make({
          instanceId: "plugins",
          binaryPath: binary!,
          profileDirectory: path.join(root, "profile"),
          environment: {
            ...environment,
            HOME: root,
            KILO_DISABLE_PROJECT_CONFIG: "0",
            KILO_PURE: "0",
            KILO_CONFIG_CONTENT: encodeJson({ plugin: [explicitPlugin] }),
          },
        });
        const connection = yield* runtime.open(cwd);
        yield* connection.client.models();
        const ref = yield* connection.client.create([
          { permission: "*", pattern: "*", action: "ask" },
        ]);
        assert.equal((yield* connection.client.read(ref)).id, ref.sessionId);
        assert.isTrue(yield* fs.exists(marker));
        assert.isTrue(yield* fs.exists(explicitMarker));
        if (platform === "linux") {
          const ledgerDir = path.join(root, "profile", "t3-processes", "opencode-servers");
          const entry = (yield* fs.readDirectory(ledgerDir))[0]!;
          const recorded = yield* decodeGroup(
            yield* fs.readFileString(path.join(ledgerDir, entry)),
          );
          const descendants = [
            Number(yield* fs.readFileString(marker)),
            Number(yield* fs.readFileString(explicitMarker)),
          ];
          const observe = (pid: number) =>
            fs.readFileString(`/proc/${pid}/stat`).pipe(
              Effect.map((stat) => {
                const fields = stat
                  .slice(stat.lastIndexOf(")") + 2)
                  .trim()
                  .split(/\s+/);
                assert.match(fields[19]!, /^\d+$/);
                return { startTime: fields[19]!, state: fields[0]! };
              }),
              Effect.catchTag("PlatformError", (error) =>
                error.reason._tag === "NotFound" ? Effect.succeed(undefined) : Effect.fail(error),
              ),
            );
          const identities = yield* Effect.forEach(descendants, (pid) =>
            Effect.gen(function* () {
              const observed = yield* observe(pid);
              assert.isDefined(observed);
              assert.notEqual(observed!.state, "Z");
              return { pid, startTime: observed!.startTime };
            }),
          );
          // This test proves eventual cleanup of these fixture children, not the
          // ordering of replacement. The handoff test verifies that separately.
          process.kill(recorded.pgid, "SIGKILL");
          yield* connection.exitCode;
          yield* Effect.forEach(identities, (identity) =>
            Effect.gen(function* () {
              for (;;) {
                const current = yield* observe(identity.pid);
                if (
                  current === undefined ||
                  current.startTime !== identity.startTime ||
                  current.state === "Z" ||
                  current.state === "X"
                )
                  return;
                yield* Effect.sleep("10 millis");
              }
            }).pipe(Effect.timeout("2 seconds")),
          );
        }
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    { timeout: 30000 },
  );

  it.live(
    "retires live clients and rejects saved threads after credentials change in the same profile",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-kilo-account-change-" });
        const authDir = path.join(root, "data", "kilo");
        const authFile = path.join(authDir, "auth.json");
        yield* fs.makeDirectory(authDir, { recursive: true });
        const credentials = (key: string) => JSON.stringify({ kilo: { type: "api", key } });
        yield* fs.writeFileString(authFile, credentials("synthetic-account-a"));
        const runtime = yield* KiloRuntime.make({
          instanceId: "account-test",
          binaryPath: binary!,
          profileDirectory: root,
          environment: { ...environment, HOME: root },
        });
        const connection = yield* runtime.open(root);
        const native = yield* connection.client.create([]);
        const create = KiloDriver.create({
          instanceId: ProviderInstanceId.make("account-test"),
          displayName: undefined,
          enabled: false,
          config: { ...KiloDriver.defaultConfig(), binaryPath: binary!, profileDirectory: root },
          environment: Object.entries({ ...environment, HOME: root }).flatMap(([name, value]) =>
            value === undefined ? [] : [{ name, value, sensitive: false }],
          ),
        });
        const verify = Effect.gen(function* () {
          const first = yield* create;
          const request = {
            threadId: ThreadId.make("account-test"),
            providerSessionId: ProviderSessionId.make("account-test"),
            modelSelection: { instanceId: first.instanceId, model: "fixture/test" },
            runtimePolicy: {
              runtimeMode: "full-access" as const,
              interactionMode: "default" as const,
              cwd: root,
            },
          };
          const firstSession = yield* first.orchestrationAdapter.openSession(request);
          const thread = yield* firstSession.ensureThread(request);
          const unchanged = yield* create;
          assert.deepStrictEqual(unchanged.continuationIdentity, first.continuationIdentity);
          const resumed = yield* unchanged.orchestrationAdapter.openSession(request);
          assert.equal(
            (yield* resumed.resumeThread({ providerThread: thread })).nativeThreadRef?.nativeId,
            thread.nativeThreadRef?.nativeId,
          );
          yield* fs.writeFileString(authFile, credentials("synthetic-account-b"));
          const failure = yield* connection.client.read(native).pipe(Effect.flip);
          assert.equal(failure.reason, "wrong_owner");
          yield* connection.exitCode.pipe(Effect.timeout("5 seconds"));
          assert.isFalse(yield* connection.isRunning);
          yield* runtime.open(root).pipe(Effect.flip);
          const replacement = yield* create;
          assert.notEqual(
            replacement.continuationIdentity.continuationKey,
            first.continuationIdentity.continuationKey,
          );
          const secondSession = yield* replacement.orchestrationAdapter.openSession(request);
          const rejected = yield* secondSession
            .resumeThread({ providerThread: thread })
            .pipe(Effect.flip);
          assert.include(rejected.message, "account or configuration changed");
          const fresh = yield* secondSession.ensureThread(request);
          assert.notEqual(fresh.nativeThreadRef?.nativeId, thread.nativeThreadRef?.nativeId);
        });
        yield* verify.pipe(
          Effect.provide(
            Layer.mergeAll(
              ServerConfig.layerTest(root, { prefix: "t3-kilo-driver-" }),
              IdAllocator.layer,
            ),
          ),
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    { timeout: 60000 },
  );

  it.live("rejects malformed credentials without exposing them or falling back to disk", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-kilo-auth-" });
      for (const content of ["", "secret-not-json", "null", "[]"]) {
        const failure = yield* KiloRuntime.readAuth(root, { KILO_AUTH_CONTENT: content }).pipe(
          Effect.flip,
        );
        assert.equal(failure.operation, "authentication");
        assert.notInclude(failure.message, "secret-not-json");
        assert.isUndefined(failure.cause);
      }
      assert.equal(yield* KiloRuntime.readAuth(root, {}), "{}");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live(
    "isolates profiles, closes owned processes and resumes after restart",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-kilo-runtime-" });
        const cwd = path.join(root, "work");
        yield* fs.makeDirectory(cwd);
        const accountScope = yield* Scope.fork(yield* Effect.scope);
        const runtime = yield* KiloRuntime.make({
          instanceId: "personal",
          binaryPath: binary!,
          profileDirectory: path.join(root, "personal"),
          environment: { ...environment, HOME: root },
        }).pipe(Effect.provideService(Scope.Scope, accountScope));
        const work = yield* KiloRuntime.make({
          instanceId: "work",
          binaryPath: binary!,
          profileDirectory: path.join(root, "work-account"),
          environment: { ...environment, HOME: root },
        });
        const sessionScope = yield* Scope.fork(yield* Effect.scope);
        const first = yield* runtime
          .open(cwd)
          .pipe(Effect.provideService(Scope.Scope, sessionScope));
        const other = yield* work.open(cwd);
        const ref = yield* first.client.create([]);
        const foreign = { ...ref, instanceId: "work" };
        yield* other.client.read(foreign).pipe(Effect.flip);
        const otherRef = yield* other.client.create([]);
        yield* Scope.close(sessionScope, Exit.void);
        assert.isFalse(yield* first.isRunning);
        assert.isTrue(yield* other.isRunning);
        const resumed = yield* runtime.open(cwd);
        assert.equal((yield* resumed.client.read(ref)).id, ref.sessionId);
        yield* Scope.close(accountScope, Exit.void);
        assert.isFalse(yield* resumed.isRunning);
        const retired = yield* runtime.open(cwd).pipe(Effect.flip);
        assert.equal(retired.operation, "open");
        assert.isTrue(yield* other.isRunning);
        assert.equal((yield* other.client.read(otherRef)).id, otherRef.sessionId);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    { timeout: 30000 },
  );

  for (const globalLedger of [false, true])
    it.live.skipIf(platform !== "linux")(
      `reaps a real Kilo owner crash, including moved profiles: globalLedger=${globalLedger}`,
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-kilo-crash-" });
          const profile = path.join(root, "profile");
          yield* fs.makeDirectory(profile);
          const processStateDirectory = path.join(root, "server-state");
          const ledgerDir = path.join(
            globalLedger ? processStateDirectory : path.join(profile, "t3-processes"),
            "opencode-servers",
          );
          let group: number | undefined;
          const owner = yield* Effect.acquireRelease(
            Effect.sync(() =>
              NodeChildProcess.spawn(
                process.execPath,
                [
                  NodeURL.fileURLToPath(
                    new URL("./KiloRuntime.crash.fixture.mjs", import.meta.url),
                  ),
                  binary!,
                  profile,
                  ...(globalLedger ? [processStateDirectory] : []),
                ],
                { stdio: ["ignore", "ignore", "ignore", "ipc"] },
              ),
            ),
            (child) =>
              Effect.sync(() => {
                child.kill("SIGKILL");
                if (group !== undefined) {
                  try {
                    process.kill(-group, "SIGKILL");
                  } catch {
                    /* already stopped */
                  }
                }
              }),
          );
          const message = yield* Effect.promise(
            () =>
              new Promise<{
                pid: number;
                session: { instanceId: string; sessionId: string; directory: string };
              }>((resolve, reject) => {
                owner.on("message", (value) => {
                  const message = value as {
                    type: string;
                    pid: number;
                    session: { instanceId: string; sessionId: string; directory: string };
                  };
                  group = message.pid;
                  if (message.type === "ready") resolve(message);
                });
                owner.once("exit", () =>
                  reject(new Error("Kilo crash fixture exited before readiness")),
                );
                owner.once("error", reject);
              }),
          );
          const entries = yield* fs.readDirectory(ledgerDir);
          assert.equal(entries.length, 1);
          const recorded = yield* decodeOwner(
            yield* fs.readFileString(path.join(ledgerDir, entries[0]!)),
          );
          assert.equal(recorded.owner.pid, owner.pid);
          assert.equal(recorded.pgid, group);
          const exited = NodeEvents.EventEmitter.once(owner, "exit");
          owner.kill("SIGKILL");
          yield* Effect.promise(() => exited);
          const running = (pid: number) =>
            fs.readFileString(`/proc/${pid}/stat`).pipe(
              Effect.map((stat) => !stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z")),
              Effect.orElseSucceed(() => false),
            );
          assert.isTrue(yield* running(message.pid));
          const replacementProfile = globalLedger ? path.join(root, "moved-profile") : profile;
          if (globalLedger) {
            yield* fs.rename(profile, replacementProfile);
            yield* fs.makeDirectory(profile);
          }
          const restarted = yield* KiloRuntime.make({
            instanceId: "crash-fixture",
            binaryPath: binary!,
            profileDirectory: replacementProfile,
            ...(globalLedger ? { processStateDirectory } : {}),
            environment: { ...environment, HOME: profile },
          });
          assert.isFalse(yield* running(message.pid));
          assert.deepEqual(yield* fs.readDirectory(ledgerDir), []);
          const fresh = yield* restarted.open(profile);
          if (globalLedger) {
            const newSession = yield* fresh.client.create([]);
            assert.notEqual(newSession.sessionId, message.session.sessionId);
          } else
            assert.equal((yield* fresh.client.read(message.session)).id, message.session.sessionId);
          assert.isTrue(yield* fresh.isRunning);
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
      { timeout: 30000 },
    );

  it.live(
    "cleans failed startup and can open a fresh process afterward",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-kilo-startup-" });
        const bad = yield* KiloRuntime.make({
          instanceId: "broken",
          binaryPath: path.join(root, "missing"),
          profileDirectory: root,
          environment: { ...environment, HOME: root },
        });
        const failure = yield* bad.open(root).pipe(Effect.flip);
        assert.equal(failure.operation, "spawn");
        const earlyExit = path.join(root, "early-exit");
        yield* fs.writeFileString(
          earlyExit,
          "#!/bin/sh\necho do-not-leak-this-diagnostic >&2\nexit 7\n",
        );
        yield* fs.chmod(earlyExit, 0o700);
        const exiting = yield* KiloRuntime.make({
          instanceId: "early",
          binaryPath: earlyExit,
          profileDirectory: root,
          environment: { ...environment, HOME: root },
        });
        const earlyFailure = yield* exiting.open(root).pipe(Effect.flip);
        assert.equal(earlyFailure.operation, "startup");
        assert.notInclude(earlyFailure.message, "do-not-leak");
        assert.include(earlyFailure.message, "code 7");
        const good = yield* KiloRuntime.make({
          instanceId: "working",
          binaryPath: binary!,
          profileDirectory: root,
          environment: { ...environment, HOME: root },
        });
        const connection = yield* good.open(root);
        assert.isTrue(yield* connection.isRunning);
        yield* connection.client.create([]);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    { timeout: 30000 },
  );
});
