// @effect-diagnostics nodeBuiltinImport:off - real CLI lifecycle and spawn observation.
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";
import * as NodeFS from "node:fs";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as KiloRuntime from "./KiloRuntime.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const binary = process.env.KILO_BIN;
it.live.skipIf(!binary || HostProcessPlatform.defaultValue() !== "linux")(
  "confirms the observed child exit before cleanup returns and a replacement really starts",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-kilo-handoff-" });
      const plugin = path.join(root, "fixture.ts");
      const marker = path.join(root, "child");
      const ready = yield* Deferred.make<void>();
      yield* Effect.acquireRelease(
        Effect.sync(() =>
          NodeFS.watch(root, (event, file) => {
            if (event === "change" && file === "child") Deferred.doneUnsafe(ready, Effect.void);
          }),
        ),
        (watcher) => Effect.sync(() => watcher.close()),
      );
      const childCode = `require('node:fs').writeFileSync(${encodeJson(marker)},String(process.pid));setInterval(()=>{},1000)`;
      yield* fs.writeFileString(
        plugin,
        `import {spawn} from 'node:child_process';
spawn(${encodeJson(process.execPath)},['-e',${encodeJson(childCode)}],{stdio:'ignore'});
export const fixture=async()=>({});\n`,
      );
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const replacement = yield* Deferred.make<void>();
      const timeline: Array<string> = [];
      let armed = false;
      let child = 0;
      let identity = "";
      let starts = 0;
      const observedFs: FileSystem.FileSystem = {
        ...fs,
        readDirectory: (directory) =>
          directory === "/proc" && armed
            ? Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.andThen(fs.readDirectory(directory)),
              )
            : fs.readDirectory(directory),
        readFileString: (file, ...args) =>
          fs.readFileString(file, ...args).pipe(
            Effect.tap((stat) =>
              Effect.sync(() => {
                if (!armed || file !== `/proc/${child}/stat`) return;
                const fields = stat
                  .slice(stat.lastIndexOf(")") + 2)
                  .trim()
                  .split(/\s+/);
                assert.equal(fields[19], identity);
                if (fields[0] === "Z" || fields[0] === "X") timeline.push("child-exit-confirmed");
              }),
            ),
            Effect.tapError((error) =>
              Effect.sync(() => {
                if (armed && file === `/proc/${child}/stat` && error.reason._tag === "NotFound")
                  timeline.push("child-exit-confirmed");
              }),
            ),
          ),
      };
      const observedSpawner = ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          starts++;
          if (starts === 2) {
            timeline.push("replacement-spawn");
            yield* Deferred.succeed(replacement, undefined);
          }
          return yield* spawner.spawn(command);
        }),
      );
      yield* Effect.gen(function* () {
        const runtime = yield* KiloRuntime.make({
          instanceId: "handoff",
          binaryPath: binary!,
          profileDirectory: path.join(root, "profile"),
          environment: {
            PATH: process.env.PATH,
            HTTP_PROXY: process.env.HTTP_PROXY,
            HTTPS_PROXY: process.env.HTTPS_PROXY,
            NO_PROXY: process.env.NO_PROXY,
            NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS,
            KILO_DISABLE_PROJECT_CONFIG: "1",
            HOME: root,
            npm_config_offline: "true",
            KILO_DISABLE_MODELS_FETCH: "1",
            KILO_DISABLE_DEFAULT_PLUGINS: "1",
            KILO_DISABLE_EXTERNAL_SKILLS: "1",
            KILO_CONFIG_CONTENT: encodeJson({ plugin: [plugin] }),
          },
        });
        const first = yield* runtime.open(root);
        yield* first.client.models();
        yield* Deferred.await(ready);
        child = Number(yield* fs.readFileString(marker));
        const fields = (yield* fs.readFileString(`/proc/${child}/stat`))
          .split(")")
          .at(-1)!
          .trim()
          .split(/\s+/);
        identity = fields[19]!;
        assert.notEqual(fields[0], "Z");
        armed = true;
        const handoff = yield* first.stop.pipe(
          Effect.tap(() => Effect.sync(() => timeline.push("cleanup-return"))),
          Effect.andThen(runtime.open(root)),
          Effect.forkScoped,
        );
        // Old cleanup reaches the real second spawn instead of the observation gate.
        const milestone = yield* Effect.raceFirst(
          Deferred.await(entered).pipe(Effect.as("observation")),
          Deferred.await(replacement).pipe(Effect.as("replacement")),
        );
        // Release even when the negative control fails, so no fixture is parked.
        yield* Deferred.succeed(release, undefined);
        assert.equal(milestone, "observation");
        const second = yield* Fiber.join(handoff);
        assert.isTrue(yield* second.isRunning);
        assert.equal(starts, 2);
        assert.isTrue(timeline.indexOf("child-exit-confirmed") >= 0);
        assert.isBelow(
          timeline.indexOf("child-exit-confirmed"),
          timeline.indexOf("cleanup-return"),
        );
        assert.isBelow(timeline.indexOf("cleanup-return"), timeline.indexOf("replacement-spawn"));
        armed = false;
        yield* second.stop;
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, observedFs),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, observedSpawner),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { timeout: 30000 },
);

it.live.skipIf(HostProcessPlatform.defaultValue() !== "linux")(
  "recovers a persisted cleanup reservation after its writer crashes in another OS process",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-kilo-restart-" });
      const launch = (code: string) =>
        Effect.acquireRelease(
          Effect.gen(function* () {
            const ready = yield* Deferred.make<void>();
            const exited = yield* Deferred.make<number | null>();
            let output = "";
            let stderr = "";
            const child = NodeChildProcess.spawn(
              process.execPath,
              ["--input-type=module", "-e", code],
              {
                cwd: NodeURL.fileURLToPath(new URL("../../../", import.meta.url)),
                detached: true,
                stdio: ["ignore", "pipe", "pipe"],
                env: { PATH: process.env.PATH },
              },
            );
            child.stdout.on("data", (chunk) => {
              output += String(chunk);
              if (output.includes("ready")) Deferred.doneUnsafe(ready, Effect.void);
            });
            child.stderr.on("data", (chunk) => {
              stderr += String(chunk);
            });
            child.once("error", (error) => {
              Deferred.doneUnsafe(ready, Effect.die(error));
              Deferred.doneUnsafe(exited, Effect.die(error));
            });
            child.once("exit", (code) => {
              Deferred.doneUnsafe(ready, Effect.die(`fixture exited before readiness: ${stderr}`));
              Deferred.doneUnsafe(exited, Effect.succeed(code));
            });
            return {
              child,
              ready: Deferred.await(ready),
              exited: Deferred.await(exited),
              output: () => output,
            };
          }),
          ({ child, exited }) =>
            Effect.sync(() => {
              child.kill("SIGKILL");
            }).pipe(Effect.andThen(exited), Effect.asVoid),
        );
      const member = yield* launch("process.stdout.write('ready');setInterval(()=>{},1000)");
      yield* member.ready;
      const imports = `import * as Effect from 'effect/Effect';
import * as NodeServices from '@effect/platform-node/NodeServices';
import * as Cleanup from ${encodeJson(new URL("./KiloProcessCleanup.ts", import.meta.url).href)};
`;
      const make = `const cleanup = yield* Cleanup.make({profile:${encodeJson(root)},stateDir:${encodeJson(root)}});`;
      const writer = yield* launch(`${imports}
await Effect.runPromise(Effect.gen(function*(){${make}
yield* cleanup.verify(${member.child.pid},Effect.sync(()=>process.stdout.write('ready')).pipe(Effect.andThen(Effect.never)));
}).pipe(Effect.provide(NodeServices.layer)));`);
      yield* writer.ready; // The real file was saved before verify enters its stop action.
      writer.child.kill("SIGKILL");
      yield* writer.exited;
      const attempt = `${imports}
await Effect.runPromise(Effect.gen(function*(){${make}
yield* cleanup.withStart(Effect.sync(()=>process.stdout.write('spawn')));
}).pipe(Effect.provide(NodeServices.layer),Effect.catch(()=>Effect.sync(()=>{process.exitCode=23;}))));`;
      const blocked = yield* launch(attempt);
      assert.equal(yield* blocked.exited, 23);
      assert.equal(blocked.output(), "");
      const [key] = yield* fs.readDirectory(path.join(root, "kilo-cleanup"));
      assert.deepEqual(yield* fs.readDirectory(path.join(root, "kilo-cleanup", key!)), [
        `${member.child.pid}.json`,
      ]);
      member.child.kill("SIGKILL");
      yield* member.exited; // This parent reaps its own child, rather than inferring exit from kill success.
      const recovered = yield* launch(attempt);
      assert.equal(yield* recovered.exited, 0);
      assert.equal(recovered.output(), "spawn");
      assert.deepEqual(yield* fs.readDirectory(path.join(root, "kilo-cleanup", key!)), []);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { timeout: 15000 },
);
