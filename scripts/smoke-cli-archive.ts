#!/usr/bin/env node
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Command, Flag } from "effect/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as NetService from "@t3tools/shared/Net";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { windowsSystemTar } from "./lib/windows-tar.ts";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

export const isCliPageResponse = (
  status: number,
  contentType: string | undefined,
  body: string,
  expected: string,
) =>
  status === 200 &&
  contentType?.split(";", 1)[0]?.trim().toLowerCase() === "text/html" &&
  body.length > 0 &&
  body === expected;

const ProcessRuntime = Schema.Struct({
  pid: Schema.Int,
  nodeVersion: Schema.String,
  executablePath: Schema.String,
});
const decodeRuntime = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      ...ProcessRuntime.fields,
      launcherRuntime: Schema.optional(ProcessRuntime),
    }),
  ),
);
const decodePreflight = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      status: Schema.Literal("ready"),
      version: Schema.String,
      nodeVersion: Schema.String,
      executablePath: Schema.String,
    }),
  ),
);
const decodeEnvironment = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      environmentId: Schema.String,
      serverVersion: Schema.String,
    }),
  ),
);
const encodeServiceState = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      protocol: Schema.Literal(3),
      activeVersion: Schema.String,
    }),
  ),
);

export class CliArchiveSmokeError extends Schema.TaggedError<CliArchiveSmokeError>()(
  "CliArchiveSmokeError",
  { step: Schema.String, detail: Schema.String },
) {
  override get message(): string {
    return `CLI archive smoke test failed while ${this.step}: ${this.detail}`;
  }
}

const collect = <E>(stream: Stream.Stream<Uint8Array, E>) =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (acc, chunk) => acc + chunk,
    ),
  );

const runExecutable = Effect.fn("runExecutable")(function* (
  executable: string,
  args: ReadonlyArray<string>,
  cwd: string,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(
    ChildProcess.make(executable, args, {
      cwd,
      // Empty PATH: the archive must not reach a system node, and the
      // launcher context must not leak in from a developer shell.
      env: { PATH: "", HOME: cwd, USERPROFILE: cwd, TMPDIR: cwd, TEMP: cwd },
      extendEnv: false,
    }),
  );
  const [stdout, stderr, exitCode] = yield* Effect.all(
    [collect(child.stdout), collect(child.stderr), child.exitCode.pipe(Effect.map(Number))],
    { concurrency: "unbounded" },
  );
  return { stdout, stderr, exitCode };
});

const smokeCliArchive = Effect.fn("smokeCliArchive")(function* (input: {
  readonly archive: string;
  readonly expectVersion: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const scratch = yield* fs
    .makeTempDirectory({ prefix: "t3-cli-smoke-" })
    .pipe(Effect.flatMap(fs.realPath));
  // Windows can keep t3.exe locked (EBUSY) for a moment after the server
  // exits. A leftover scratch directory on a CI runner is harmless, so
  // cleanup retries briefly and never fails a smoke test that passed.
  yield* Effect.addFinalizer(() =>
    fs.remove(scratch, { recursive: true }).pipe(
      Effect.retry({ times: 10, schedule: Schedule.spaced("500 millis") }),
      Effect.catch((error) =>
        Effect.logWarning(`[cli-smoke] could not remove ${scratch}: ${error.message}`),
      ),
    ),
  );

  // On Windows the archive is a zip and the Git Bash `tar` on PATH is GNU
  // tar; use the bsdtar Windows ships, which reads both formats.
  const tar = platform === "win32" ? windowsSystemTar() : "tar";
  const extract = yield* spawner
    .spawn(ChildProcess.make(tar, ["-xf", input.archive, "-C", scratch]))
    .pipe(Effect.flatMap((child) => child.exitCode));
  if (Number(extract) !== 0) {
    return yield* new CliArchiveSmokeError({
      step: "extracting the archive",
      detail: `tar exited with ${String(extract)}`,
    });
  }
  const [root] = yield* fs.readDirectory(scratch);
  if (root === undefined) {
    return yield* new CliArchiveSmokeError({
      step: "extracting the archive",
      detail: "the archive was empty",
    });
  }
  const contentDir = path.join(scratch, root);
  const executable = path.join(contentDir, platform === "win32" ? "t3.exe" : "t3");
  for (const required of [executable, path.join(contentDir, "client/index.html")]) {
    if (!(yield* fs.exists(required))) {
      return yield* new CliArchiveSmokeError({
        step: "checking the archive layout",
        detail: `missing ${path.relative(contentDir, required)}`,
      });
    }
  }

  const version = yield* runExecutable(executable, ["--version"], contentDir);
  if (version.exitCode !== 0 || !version.stdout.includes(input.expectVersion)) {
    return yield* new CliArchiveSmokeError({
      step: "running --version",
      detail: `exit ${String(version.exitCode)}\n${version.stdout}${version.stderr}`,
    });
  }

  const preflight = yield* runExecutable(
    executable,
    [
      "__service-preflight",
      "--database-path",
      path.join(scratch, "unused.sqlite"),
      "--launcher-protocol",
      "3",
    ],
    contentDir,
  );
  const runtime = yield* decodePreflight(preflight.stdout.trim()).pipe(Effect.option);
  if (
    preflight.exitCode !== 0 ||
    runtime._tag === "None" ||
    runtime.value.version !== input.expectVersion ||
    runtime.value.nodeVersion.length === 0 ||
    runtime.value.executablePath !== executable
  ) {
    return yield* new CliArchiveSmokeError({
      step: "checking the packaged Node runtime",
      detail: `expected runtime metadata from ${executable} at version ${input.expectVersion}\n${preflight.stdout}${preflight.stderr}`,
    });
  }
  const expectedNodeVersion = runtime.value.nodeVersion;

  const net = yield* NetService.NetService;
  const port = yield* net.findAvailablePort(47700);
  const home = path.join(scratch, "home");
  const httpClient = yield* HttpClient.HttpClient;
  const expectedPage = yield* fs.readFileString(path.join(contentDir, "client/index.html"));
  const runtimeStatePath = path.join(home, "userdata/server-runtime.json");
  const checkServer = Effect.fn("cliSmoke.checkServer")(function* (
    entry: string,
    managed: boolean,
  ) {
    const server = yield* spawner.spawn(
      ChildProcess.make(entry, managed ? ["__service-launcher"] : ["serve", "--no-browser"], {
        cwd: path.dirname(entry),
        env: {
          PATH: "",
          HOME: home,
          USERPROFILE: home,
          TMPDIR: scratch,
          TEMP: scratch,
          T3CODE_HOME: home,
          T3CODE_HOST: "127.0.0.1",
          T3CODE_PORT: String(port),
        },
        extendEnv: false,
      }),
    );
    const output = yield* Effect.forkScoped(
      Effect.all([collect(server.stdout), collect(server.stderr)]),
    );
    const probe = Effect.gen(function* () {
      const response = yield* httpClient.execute(
        HttpClientRequest.get(`http://127.0.0.1:${String(port)}/`),
      );
      if (
        !isCliPageResponse(
          response.status,
          response.headers["content-type"],
          yield* response.text,
          expectedPage,
        )
      )
        return undefined;
      const metadata = yield* httpClient.execute(
        HttpClientRequest.get(`http://127.0.0.1:${String(port)}/.well-known/t3/environment`),
      );
      if (metadata.status !== 200) return undefined;
      const environment = yield* decodeEnvironment(yield* metadata.text);
      const state = yield* decodeRuntime(yield* fs.readFileString(runtimeStatePath));
      if (
        environment.serverVersion !== input.expectVersion ||
        state.nodeVersion !== expectedNodeVersion ||
        state.executablePath !== entry
      )
        return undefined;
      if (
        managed &&
        (state.launcherRuntime?.nodeVersion !== expectedNodeVersion ||
          state.launcherRuntime.executablePath !== entry ||
          state.launcherRuntime.pid !== Number(server.pid))
      )
        return undefined;
      if (!managed && state.pid !== Number(server.pid)) return undefined;
      return environment.environmentId;
    }).pipe(
      Effect.timeout(Duration.seconds(2)),
      Effect.orElseSucceed(() => undefined),
    );
    const ready = yield* Effect.gen(function* () {
      for (;;) {
        const environmentId = yield* probe;
        if (environmentId !== undefined) return environmentId;
        yield* Effect.sleep(Duration.millis(250));
      }
    }).pipe(
      Effect.timeout(Duration.seconds(30)),
      Effect.orElseSucceed(() => undefined),
    );
    yield* server.kill({ killSignal: "SIGTERM" }).pipe(Effect.ignore);
    const exitCode = yield* server.exitCode.pipe(
      Effect.timeout(Duration.seconds(10)),
      Effect.orElseSucceed(() => undefined),
    );
    const [stdout, stderr] = yield* Fiber.join(output).pipe(
      Effect.timeout(Duration.seconds(5)),
      Effect.orElseSucceed(() => ["", ""] as const),
    );
    if (ready === undefined || exitCode === undefined) {
      return yield* new CliArchiveSmokeError({
        step: managed ? "starting the service launcher" : "serving from the extracted archive",
        detail: `expected the shipped text/html page, environment metadata and Node ${expectedNodeVersion}, followed by shutdown\n${stdout}${stderr}`,
      });
    }
    return ready;
  }, Effect.scoped);
  const environmentId = yield* checkServer(executable, false);
  const managedDir = path.join(home, "runtime/versions", input.expectVersion);
  yield* fs.makeDirectory(path.dirname(managedDir), { recursive: true });
  yield* fs
    .rename(contentDir, managedDir)
    .pipe(Effect.retry({ times: 10, schedule: Schedule.spaced("500 millis") }));
  yield* fs.writeFileString(path.join(managedDir, ".install-complete"), `${input.expectVersion}\n`);
  yield* fs.writeFileString(
    path.join(home, "runtime/service-state.json"),
    yield* encodeServiceState({ protocol: 3, activeVersion: input.expectVersion }),
  );
  const managedEntry = path.join(managedDir, platform === "win32" ? "t3.exe" : "t3");
  for (let start = 0; start < 2; start++) {
    if ((yield* checkServer(managedEntry, true)) !== environmentId) {
      return yield* new CliArchiveSmokeError({
        step: "restarting the launcher",
        detail: "environment identity changed across restart",
      });
    }
  }
  yield* Effect.log(
    `[cli-smoke] ${root}: CLI, server and launcher use Node ${expectedNodeVersion}; HTTP, environment identity and full launcher restart passed with empty PATH.`,
  );
});

const command = Command.make(
  "smoke-cli-archive",
  {
    archive: Flag.String("archive"),
    expectVersion: Flag.String("expect-version"),
  },
  (input) => smokeCliArchive(input).pipe(Effect.scoped),
).pipe(Command.withDescription("Extract a CLI archive and run its executable."));

if (import.meta.main) {
  Command.run(command, { version: "0.0.0" }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Logger.layer([Logger.consolePretty()]),
        NodeServices.layer,
        NetService.layer,
        FetchHttpClient.layer,
      ),
    ),
    NodeRuntime.runMain,
  );
}
