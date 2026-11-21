import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  ThreadId,
  type BlenderJob,
  type BlenderStatus,
  type ServerSettings as ServerSettingsSchema,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Stream from "effect/Stream";

import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Blender from "./Blender.ts";

type ProbeOutput = {
  readonly stdout?: string;
  readonly code?: number;
  readonly timedOut?: boolean;
  readonly spawnFails?: true;
};

const BLENDER_42 = "Blender 4.2.1 LTS\n\tbuild date: 2024-08-19\n";

const noThreads: Blender.BlenderThreads = {
  workspaceRoot: () => Effect.succeed(null),
  stops: Stream.never,
};

/** Runs one status read against a temp host whose files and probe output the case controls. */
const readStatus = Effect.fn(function* (input: {
  readonly blender?: Partial<ServerSettingsSchema["blender"]>;
  readonly platform?: NodeJS.Platform;
  /** Executables to create, relative to the temp root. */
  readonly executables?: ReadonlyArray<string>;
  /** PATH entries, relative to the temp root. */
  readonly path?: ReadonlyArray<string>;
  readonly output?: ProbeOutput;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-blender-" });
  for (const executable of input.executables ?? []) {
    const file = path.join(root, executable);
    yield* fs.makeDirectory(path.dirname(file), { recursive: true });
    yield* fs.writeFileString(file, "#!/bin/sh\n");
    yield* fs.chmod(file, 0o755);
  }
  const probes: Array<{ readonly command: string; readonly args: ReadonlyArray<string> }> = [];
  const runner = ProcessRunner.ProcessRunner.of({
    run: (run) => {
      probes.push({ command: run.command, args: run.args });
      const output = input.output ?? { stdout: BLENDER_42 };
      if (output.spawnFails) {
        return Effect.fail(
          new ProcessRunner.ProcessSpawnError({
            command: run.command,
            argumentCount: run.args.length,
            cause: new Error("EACCES"),
          }),
        );
      }
      return Effect.succeed({
        stdout: output.stdout ?? "",
        stderr: "",
        code: output.timedOut ? null : ChildProcessSpawner.ExitCode(output.code ?? 0),
        timedOut: output.timedOut ?? false,
        stdoutTruncated: false,
        stderrTruncated: false,
        stdoutInvalidUtf8: false,
        stderrInvalidUtf8: false,
      });
    },
  });
  const blender = input.blender ?? { enabled: true };
  const status = yield* Effect.gen(function* () {
    const service = yield* Blender.Blender;
    return yield* service.status;
  }).pipe(
    Effect.provide(
      Blender.layerWith({ threads: noThreads, rootDir: path.join(root, "state") }).pipe(
        Layer.provide(
          ServerSettings.layerTest({
            blender: {
              ...blender,
              ...(blender.executablePath
                ? { executablePath: path.join(root, blender.executablePath) }
                : {}),
            },
          }),
        ),
      ),
    ),
    Effect.provideService(ProcessRunner.ProcessRunner, runner),
    Effect.provide(SecureRandom.layerWebCrypto),
    Effect.provideService(HostProcess.Platform, input.platform ?? "linux"),
    Effect.provideService(HostProcess.HomeDirectory, path.join(root, "home")),
    Effect.provideService(HostProcess.Environment, {
      // Every platform these cases fake separates PATH entries with ":".
      PATH: (input.path ?? []).map((entry) => path.join(root, entry)).join(":"),
    }),
  );
  return { status, probes, root };
});

describe("Blender.status", () => {
  it.effect("does not probe while the integration is disabled, which is the default", () =>
    Effect.gen(function* () {
      const { status, probes } = yield* readStatus({
        blender: {},
        executables: ["bin/blender"],
        path: ["bin"],
      });
      assert.deepStrictEqual(status, { _tag: "Disabled" });
      assert.strictEqual(probes.length, 0);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("detects Blender on PATH and probes its version", () =>
    Effect.gen(function* () {
      const { status, probes, root } = yield* readStatus({
        executables: ["bin/blender"],
        path: ["bin"],
      });
      assert.deepStrictEqual(status, {
        _tag: "Available",
        executablePath: `${root}/bin/blender`,
        source: "path",
        version: "4.2.1",
      });
      assert.deepStrictEqual(probes, [{ command: `${root}/bin/blender`, args: ["--version"] }]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("falls back to a standard install when PATH has no Blender", () =>
    Effect.gen(function* () {
      const { status, root } = yield* readStatus({
        platform: "darwin",
        executables: ["home/Applications/Blender.app/Contents/MacOS/Blender"],
      });
      assert.deepStrictEqual(status, {
        _tag: "Available",
        executablePath: `${root}/home/Applications/Blender.app/Contents/MacOS/Blender`,
        source: "standard-install",
        version: "4.2.1",
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("probes the override instead of detecting, and reports a missing override", () =>
    Effect.gen(function* () {
      const found = yield* readStatus({
        blender: { enabled: true, executablePath: "custom/blender-4.5" },
        executables: ["custom/blender-4.5", "bin/blender"],
        path: ["bin"],
      });
      assert.deepStrictEqual(found.status, {
        _tag: "Available",
        executablePath: `${found.root}/custom/blender-4.5`,
        source: "override",
        version: "4.2.1",
      });
      assert.deepStrictEqual(
        found.probes.map((probe) => probe.command),
        [`${found.root}/custom/blender-4.5`],
      );

      const missing = yield* readStatus({
        blender: { enabled: true, executablePath: "custom/missing" },
        executables: ["bin/blender"],
        path: ["bin"],
      });
      assert.deepStrictEqual(missing.status, { _tag: "NotFound", source: "override" });
      assert.strictEqual(missing.probes.length, 0);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("reports detection that finds nothing", () =>
    Effect.gen(function* () {
      const { status, probes } = yield* readStatus({});
      assert.deepStrictEqual(status, { _tag: "NotFound", source: "detection" });
      assert.strictEqual(probes.length, 0);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  const probeCases: ReadonlyArray<{
    readonly name: string;
    readonly output: ProbeOutput;
    readonly expected: (executablePath: string) => BlenderStatus;
  }> = [
    {
      name: "an older release as unsupported",
      output: { stdout: "Blender 3.6.5\n" },
      expected: (executablePath) => ({
        _tag: "Unsupported",
        executablePath,
        source: "path",
        version: "3.6.5",
        minimumVersion: "4.2",
      }),
    },
    {
      name: "a version line after startup warnings",
      output: { stdout: "Color management: using fallback mode\nBlender 5.0\n" },
      expected: (executablePath) => ({
        _tag: "Available",
        executablePath,
        source: "path",
        version: "5.0",
      }),
    },
    {
      name: "malformed output",
      output: { stdout: "not blender\n" },
      expected: (executablePath) => ({
        _tag: "ProbeFailed",
        executablePath,
        source: "path",
        reason: "unrecognized-output",
      }),
    },
    {
      name: "a nonzero exit, even with a version line",
      output: { stdout: BLENDER_42, code: 3 },
      expected: (executablePath) => ({
        _tag: "ProbeFailed",
        executablePath,
        source: "path",
        reason: "nonzero-exit",
        exitCode: 3,
      }),
    },
    {
      name: "an executable that cannot start",
      output: { spawnFails: true },
      expected: (executablePath) => ({
        _tag: "ProbeFailed",
        executablePath,
        source: "path",
        reason: "spawn-failed",
      }),
    },
    {
      name: "a probe that times out",
      output: { timedOut: true },
      expected: (executablePath) => ({
        _tag: "ProbeFailed",
        executablePath,
        source: "path",
        reason: "timed-out",
      }),
    },
  ];

  it.effect.each(probeCases)("reports $name", ({ output, expected }) =>
    Effect.gen(function* () {
      const { status, root } = yield* readStatus({
        executables: ["bin/blender"],
        path: ["bin"],
        output,
      });
      assert.deepStrictEqual(status, expected(`${root}/bin/blender`));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

interface FakeJob {
  readonly spec: {
    readonly resultPath: string;
    readonly outputDir: string;
    readonly outputs?: ReadonlyArray<string>;
    readonly script?: string;
    readonly savePath?: string;
  };
  /** The scene file Blender was asked to open. */
  readonly scene: string | undefined;
  readonly cwd: string | undefined;
  readonly onStdoutChunk: ((chunk: Uint8Array) => void) | undefined;
}

const exited = (code: number) => ({
  stdout: "",
  stderr: "",
  code: ChildProcessSpawner.ExitCode(code),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});

function glbFixture(text: string) {
  const payload = Buffer.from(text);
  const data = Buffer.alloc(12 + payload.length);
  data.write("glTF");
  data.writeUInt32LE(2, 4);
  data.writeUInt32LE(data.length, 8);
  payload.copy(data, 12);
  return data;
}

/** Does what the job script does for a script that succeeds. */
const writeOutputs = Effect.fn(function* (job: FakeJob) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (job.spec.outputs?.includes("preview")) {
    yield* fs.writeFile(path.join(job.spec.outputDir, "preview-1.glb"), glbFixture("binary"));
  }
  if (job.spec.outputs?.includes("render")) {
    yield* fs.writeFile(
      path.join(job.spec.outputDir, "render.png"),
      Buffer.from("89504e470d0a1a0a", "hex"),
    );
  }
  if (job.spec.savePath) yield* fs.writeFileString(job.spec.savePath, "edited scene");
});

const succeed = Effect.fn(function* (job: FakeJob) {
  const fs = yield* FileSystem.FileSystem;
  yield* writeOutputs(job);
  yield* fs.writeFileString(
    job.spec.resultPath,
    JSON.stringify({
      ok: true,
      ...(job.spec.outputs?.includes("preview") ? { previewRevision: 1 } : {}),
    }),
  );
  return exited(0);
});

const THREAD = ThreadId.make("thread-blender");
const OTHER_THREAD = ThreadId.make("thread-other");

/** A Blender service over a temp workspace whose Blender processes `run` fakes. */
const startJobs = Effect.fn(function* (input: {
  readonly run?: (
    job: FakeJob,
  ) => Effect.Effect<ReturnType<typeof exited>, never, FileSystem.FileSystem | Path.Path>;
  readonly limits?: Partial<Blender.BlenderLimits>;
  readonly onAgentJobCompleted?: (job: BlenderJob) => Effect.Effect<void>;
  readonly enabled?: boolean;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-blender-jobs-" });
  const workspace = path.join(root, "workspace");
  yield* fs.makeDirectory(path.join(workspace, "models"), { recursive: true });
  yield* fs.writeFileString(path.join(workspace, "models", "chair.blend"), "original scene");
  yield* fs.writeFileString(path.join(workspace, "edit.py"), "pass\n");
  yield* fs.writeFileString(path.join(root, "outside.blend"), "not in the workspace");
  const executable = path.join(root, "blender");
  yield* fs.writeFileString(executable, "#!/bin/sh\n");
  yield* fs.chmod(executable, 0o755);
  const stops = yield* Queue.unbounded<Blender.BlenderThreadStop>();
  const jobs: Array<FakeJob> = [];
  const services = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
  const runner = ProcessRunner.ProcessRunner.of({
    run: (run) => {
      if (run.args[0] === "--version") return Effect.succeed({ ...exited(0), stdout: BLENDER_42 });
      return Effect.gen(function* () {
        const spec = JSON.parse(yield* fs.readFileString(run.args.at(-1) ?? ""));
        const sceneIndex = run.args.indexOf("--disable-autoexec") + 1;
        const job: FakeJob = {
          spec,
          scene: run.args[sceneIndex] === "--python-exit-code" ? undefined : run.args[sceneIndex],
          cwd: run.cwd,
          onStdoutChunk: run.onStdoutChunk,
        };
        jobs.push(job);
        return yield* (input.run ?? succeed)(job);
      }).pipe(Effect.orDie, Effect.provide(services));
    },
  });
  const context = yield* Layer.build(
    Blender.layerWith({
      threads: {
        workspaceRoot: (threadId) =>
          Effect.succeed(threadId === THREAD || threadId === OTHER_THREAD ? workspace : null),
        stops: Stream.fromQueue(stops),
      },
      rootDir: path.join(root, "state"),
      ...(input.limits === undefined ? {} : { limits: input.limits }),
      ...(input.onAgentJobCompleted === undefined
        ? {}
        : { onAgentJobCompleted: input.onAgentJobCompleted }),
    }).pipe(
      Layer.provide(
        ServerSettings.layerTest({
          blender: { enabled: input.enabled ?? true, executablePath: executable },
        }),
      ),
      Layer.provide(Layer.succeed(ProcessRunner.ProcessRunner, runner)),
      Layer.provide(SecureRandom.layerWebCrypto),
    ),
  );
  return { blender: Context.get(context, Blender.Blender), jobs, stops, root, workspace };
});

const gatedRun = Effect.fn(function* () {
  const started = yield* Queue.unbounded<FakeJob>();
  const gates: Array<Deferred.Deferred<void>> = [];
  const interrupted: Array<FakeJob> = [];
  const run = (job: FakeJob) =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>();
      gates.push(gate);
      // The export is on disk before the process is stopped, as a slow script's would be.
      yield* writeOutputs(job).pipe(Effect.orDie);
      yield* Queue.offer(started, job);
      yield* Deferred.await(gate);
      return yield* succeed(job).pipe(Effect.orDie);
    }).pipe(Effect.onInterrupt(() => Effect.sync(() => interrupted.push(job))));
  return { run, started, gates, interrupted };
});

describe("Blender jobs", () => {
  it.effect("delivers a terminal event to the agent only for agent-requested jobs", () =>
    Effect.gen(function* () {
      const events = yield* Queue.unbounded<BlenderJob>();
      const { blender } = yield* startJobs({
        onAgentJobCompleted: (job) => Queue.offer(events, job).pipe(Effect.asVoid),
      });
      const request = { threadId: THREAD, script: "edit.py", outputs: [] };
      const clientJob = yield* blender.startJob(request);
      yield* blender.awaitJob({ threadId: THREAD, jobId: clientJob.id });
      const agentJob = yield* blender.startJob(request, { notifyAgent: true });
      const completed = yield* Queue.take(events);
      assert.strictEqual(completed.id, agentJob.id);
      assert.strictEqual(completed.status, "succeeded");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("serves successive complete preview revisions while the owning job is running", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const ready = yield* Deferred.make<FakeJob>();
      const finish = yield* Deferred.make<void>();
      const { blender } = yield* startJobs({
        run: (job) =>
          Deferred.succeed(ready, job).pipe(
            Effect.andThen(Deferred.await(finish)),
            Effect.andThen(succeed(job)),
            Effect.orDie,
          ),
      });
      const run = yield* blender.startJob({
        threadId: THREAD,
        input: "models/chair.blend",
        outputs: ["preview"],
      });
      const job = yield* Deferred.await(ready);
      const ref = { threadId: THREAD, jobId: run.id, output: "preview" as const };
      const notify = job.onStdoutChunk;
      assert.isDefined(notify);
      for (const revision of [1, 2]) {
        const updated = yield* Effect.forkChild(
          blender.streamThreadJobs(THREAD).pipe(
            Stream.filter(
              (event) =>
                event._tag === "Updated" &&
                event.job.id === run.id &&
                event.job.result?.preview?.revision === revision,
            ),
            Stream.runHead,
          ),
          { startImmediately: true },
        );
        const bytes = glbFixture(`preview-${revision}`);
        yield* fs.writeFile(path.join(job.spec.outputDir, `preview-${revision}.glb`), bytes);
        yield* Effect.sync(() => notify?.(Buffer.from(`T3_BLENDER_PREVIEW ${revision}\n`)));
        const published = yield* Fiber.join(updated);
        assert.deepStrictEqual(
          Option.isSome(published) && published.value._tag === "Updated"
            ? published.value.job.status
            : null,
          "running",
        );
        const file = yield* blender.outputFile({ ...ref, revision });
        assert.deepStrictEqual(Buffer.from(yield* fs.readFile(file)), bytes);
      }
      const cancelled = yield* blender.cancelJob({ threadId: THREAD, jobId: run.id });
      assert.strictEqual(cancelled.status, "cancelled");
      assert.strictEqual(cancelled.result?.preview?.revision, 2);
      assert.strictEqual(
        yield* fs.exists(yield* blender.outputFile({ ...ref, revision: 2 })),
        true,
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("edits a private copy, publishes its preview and saves the edit as a new file", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { blender, jobs, root, workspace } = yield* startJobs({});
      const queued = yield* blender.startJob({
        threadId: THREAD,
        input: "models/chair.blend",
        script: "edit.py",
        outputs: ["preview"],
        saveAs: "models/chair-v2.blend",
      });
      assert.strictEqual(queued.status, "queued");
      const job = yield* blender.awaitJob({ threadId: THREAD, jobId: queued.id });

      assert.strictEqual(job.status, "succeeded");
      assert.deepStrictEqual(job.result, {
        preview: { bytes: 18, current: true, revision: 1 },
        saved: path.join("models", "chair-v2.blend"),
      });
      const [run] = jobs;
      assert.strictEqual(run?.cwd, workspace);
      assert.strictEqual(run?.spec.script, path.join(workspace, "edit.py"));
      assert.isTrue(run?.scene?.startsWith(path.join(root, "state")));
      assert.strictEqual(
        yield* fs.readFileString(path.join(workspace, "models", "chair.blend")),
        "original scene",
      );
      assert.strictEqual(
        yield* fs.readFileString(path.join(workspace, "models", "chair-v2.blend")),
        "edited scene",
      );
      const preview = yield* blender.outputFile({
        threadId: THREAD,
        jobId: job.id,
        output: "preview",
      });
      assert.strictEqual(yield* fs.readFileString(preview), glbFixture("binary").toString());
      // Another thread cannot reach the job.
      const foreign = yield* blender
        .outputFile({ threadId: OTHER_THREAD, jobId: job.id, output: "preview" })
        .pipe(Effect.flip);
      assert.strictEqual(foreign.reason, "job-not-found");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses paths outside the workspace, existing save targets and unknown threads", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { blender, jobs, root, workspace } = yield* startJobs({});
      yield* fs.symlink(path.join(root, "outside.blend"), path.join(workspace, "link.blend"));
      const reasons = yield* Effect.forEach(
        [
          { threadId: THREAD, input: "../outside.blend", outputs: [] },
          { threadId: THREAD, input: "link.blend", outputs: [] },
          { threadId: THREAD, script: "models/chair.blend", outputs: [] },
          { threadId: THREAD, input: "models/missing.blend", outputs: [] },
          {
            threadId: THREAD,
            input: "models/chair.blend",
            saveAs: "models/chair.blend",
            outputs: [],
          },
          { threadId: THREAD, script: "edit.py", saveAs: "../escape.blend", outputs: [] },
          { threadId: THREAD, outputs: ["preview" as const] },
          { threadId: ThreadId.make("thread-unknown"), script: "edit.py", outputs: [] },
        ],
        (request) =>
          blender.startJob(request).pipe(
            Effect.flip,
            Effect.map((error) =>
              error._tag === "BlenderRequestError" ? error.reason : error._tag,
            ),
          ),
      );
      assert.deepStrictEqual(reasons, [
        "path-not-allowed",
        "path-not-allowed",
        "path-not-allowed",
        "file-not-found",
        "save-target-exists",
        "path-not-allowed",
        "invalid-request",
        "thread-not-found",
      ]);
      assert.strictEqual(jobs.length, 0);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("reports a failing script with its message and keeps nothing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { blender } = yield* startJobs({
        run: (job) =>
          fs
            .writeFileString(
              job.spec.resultPath,
              JSON.stringify({ ok: false, message: "RuntimeError: boom (edit.py line 3)" }),
            )
            .pipe(Effect.orDie, Effect.as(exited(23))),
      });
      const queued = yield* blender.startJob({
        threadId: THREAD,
        script: "edit.py",
        outputs: ["preview"],
      });
      const job = yield* blender.awaitJob({ threadId: THREAD, jobId: queued.id });
      assert.strictEqual(job.status, "failed");
      assert.deepStrictEqual(job.failure, {
        reason: "script-error",
        message: "RuntimeError: boom (edit.py line 3)",
        exitCode: 23,
      });
      const missing = yield* blender
        .outputFile({ threadId: THREAD, jobId: job.id, output: "preview" })
        .pipe(Effect.flip);
      assert.strictEqual(missing.reason, "job-not-found");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("cancels a queued job before it starts and a running one with its process", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const fake = yield* gatedRun();
      const { blender, jobs, root } = yield* startJobs({
        run: fake.run,
        limits: { runningJobs: 1 },
      });
      const running = yield* blender.startJob({
        threadId: THREAD,
        script: "edit.py",
        outputs: ["preview"],
      });
      const queued = yield* blender.startJob({
        threadId: THREAD,
        script: "edit.py",
        outputs: ["preview"],
      });
      yield* Queue.take(fake.started);

      const cancelledQueued = yield* blender.cancelJob({ threadId: THREAD, jobId: queued.id });
      assert.strictEqual(cancelledQueued.status, "cancelled");
      const cancelledRunning = yield* blender.cancelJob({ threadId: THREAD, jobId: running.id });
      assert.strictEqual(cancelledRunning.status, "cancelled");
      assert.strictEqual(cancelledRunning.cancelledBy, "request");

      // The running process was stopped, the queued one never started, and the export the
      // stopped process wrote is neither served nor kept.
      assert.strictEqual(fake.interrupted.length, 1);
      assert.strictEqual(jobs.length, 1);
      const stale = yield* blender
        .outputFile({ threadId: THREAD, jobId: running.id, output: "preview" })
        .pipe(Effect.flip);
      assert.strictEqual(stale.reason, "job-not-found");
      assert.deepStrictEqual(yield* fs.readDirectory(`${root}/state/jobs`), []);
      // Cancelling a finished job changes nothing.
      const again = yield* blender.cancelJob({ threadId: THREAD, jobId: running.id });
      assert.deepStrictEqual(again, cancelledRunning);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("marks an older job's preview as replaced when a newer job published first", () =>
    Effect.gen(function* () {
      const fake = yield* gatedRun();
      const { blender } = yield* startJobs({ run: fake.run, limits: { runningJobs: 2 } });
      const request = {
        threadId: THREAD,
        input: "models/chair.blend",
        outputs: ["preview" as const],
      };
      const older = yield* blender.startJob(request);
      const newer = yield* blender.startJob(request);
      yield* Queue.take(fake.started);
      yield* Queue.take(fake.started);
      yield* Deferred.succeed(fake.gates[1]!, undefined);
      const newerDone = yield* blender.awaitJob({ threadId: THREAD, jobId: newer.id });
      yield* Deferred.succeed(fake.gates[0]!, undefined);
      const olderDone = yield* blender.awaitJob({ threadId: THREAD, jobId: older.id });
      assert.deepStrictEqual(newerDone.result?.preview?.current, true);
      assert.deepStrictEqual(olderDone.result?.preview?.current, false);

      const latest = yield* blender.startJob(request);
      yield* Queue.take(fake.started);
      yield* Deferred.succeed(fake.gates[2]!, undefined);
      yield* blender.awaitJob({ threadId: THREAD, jobId: latest.id });
      const replaced = yield* blender.awaitJob({ threadId: THREAD, jobId: newer.id });
      assert.strictEqual(replaced.result?.preview?.current, false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("stopping a thread ends its jobs, and deleting it drops their outputs", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const fake = yield* gatedRun();
      const { blender, stops, root } = yield* startJobs({
        run: fake.run,
        limits: { runningJobs: 1 },
      });
      const request = { script: "edit.py", outputs: ["preview" as const] };
      const running = yield* blender.startJob({ threadId: THREAD, ...request });
      const queued = yield* blender.startJob({ threadId: THREAD, ...request });
      const other = yield* blender.startJob({ threadId: OTHER_THREAD, ...request });
      yield* Queue.take(fake.started);

      yield* Queue.offer(stops, { threadId: THREAD, at: running.createdAt, forget: false });
      const ended = yield* Effect.forEach([running, queued], (job) =>
        blender.awaitJob({ threadId: THREAD, jobId: job.id }),
      );
      assert.deepStrictEqual(
        ended.map((job) => [job.status, job.cancelledBy]),
        [
          ["cancelled", "thread-stopped"],
          ["cancelled", "thread-stopped"],
        ],
      );
      // The other thread's job takes the free slot and runs until its own thread is deleted.
      yield* Queue.take(fake.started);
      const otherEnded = yield* Effect.forkChild(
        blender.awaitJob({ threadId: OTHER_THREAD, jobId: other.id }),
        { startImmediately: true },
      );
      yield* Queue.offer(stops, { threadId: OTHER_THREAD, at: other.createdAt, forget: true });
      assert.strictEqual((yield* Fiber.join(otherEnded)).status, "cancelled");
      const forgotten = yield* blender
        .getJob({ threadId: OTHER_THREAD, jobId: other.id })
        .pipe(Effect.flip);
      assert.strictEqual(forgotten.reason, "job-not-found");
      assert.deepStrictEqual(yield* fs.readDirectory(`${root}/state/jobs`), []);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("streams a thread's jobs as a snapshot and then each change", () =>
    Effect.gen(function* () {
      const { blender } = yield* startJobs({});
      const earlier = yield* blender.startJob({ threadId: THREAD, script: "edit.py", outputs: [] });
      yield* blender.awaitJob({ threadId: THREAD, jobId: earlier.id });
      const events = yield* Effect.forkChild(
        blender.streamThreadJobs(THREAD).pipe(
          Stream.takeUntil((event) => event._tag === "Updated" && event.job.status === "succeeded"),
          Stream.runCollect,
        ),
        // Runs until it waits for changes, so it has subscribed before the next job starts.
        { startImmediately: true },
      );
      yield* blender.startJob({ threadId: OTHER_THREAD, script: "edit.py", outputs: [] });
      const later = yield* blender.startJob({ threadId: THREAD, script: "edit.py", outputs: [] });
      const collected = yield* Fiber.join(events);
      assert.deepStrictEqual(
        collected.map((event) =>
          event._tag === "Snapshot"
            ? ["Snapshot", event.jobs.map((job) => job.id)]
            : event._tag === "Updated"
              ? ["Updated", event.job.id, event.job.status]
              : ["Removed", event.jobId],
        ),
        [
          ["Snapshot", [earlier.id]],
          ["Updated", later.id, "queued"],
          ["Updated", later.id, "running"],
          ["Updated", later.id, "succeeded"],
        ],
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps only the newest finished jobs of a thread", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { blender, root } = yield* startJobs({ limits: { retainedJobsPerThread: 1 } });
      const request = {
        threadId: THREAD,
        input: "models/chair.blend",
        outputs: ["preview" as const],
      };
      const first = yield* blender.startJob(request);
      yield* blender.awaitJob({ threadId: THREAD, jobId: first.id });
      const second = yield* blender.startJob(request);
      yield* blender.awaitJob({ threadId: THREAD, jobId: second.id });
      const evicted = yield* blender
        .getJob({ threadId: THREAD, jobId: first.id })
        .pipe(Effect.flip);
      assert.strictEqual(evicted.reason, "job-not-found");
      assert.deepStrictEqual(yield* fs.readDirectory(`${root}/state/jobs`), [second.id]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

describe("Blender.openScene", () => {
  const scene = { threadId: THREAD, path: "models/chair.blend" };

  it.effect("shares one export per file version and replaces the export of an older one", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const fake = yield* gatedRun();
      const { blender, jobs, workspace } = yield* startJobs({
        run: fake.run,
        limits: { runningJobs: 2 },
      });
      const [first, second] = yield* Effect.all(
        [blender.openScene(scene), blender.openScene(scene)],
        {
          concurrency: "unbounded",
        },
      );
      assert.strictEqual(second.id, first.id);
      assert.strictEqual(first.input, path.join("models", "chair.blend"));
      assert.deepStrictEqual((yield* Queue.take(fake.started)).spec.outputs, ["preview"]);
      yield* Deferred.succeed(fake.gates[0]!, undefined);
      assert.strictEqual(
        (yield* blender.awaitJob({ threadId: THREAD, jobId: first.id })).status,
        "succeeded",
      );
      // Reopening the unchanged file, as a remount does, starts nothing.
      assert.strictEqual((yield* blender.openScene(scene)).id, first.id);

      const file = path.join(workspace, "models", "chair.blend");
      yield* fs.writeFileString(file, "edited scene");
      const edited = yield* blender.openScene(scene);
      yield* Queue.take(fake.started);
      yield* fs.writeFileString(file, "edited scene again");
      const latest = yield* blender.openScene(scene);
      // The replaced export has ended by the time the newer open returns.
      const replaced = yield* blender.getJob({ threadId: THREAD, jobId: edited.id });
      assert.deepStrictEqual([replaced.status, replaced.cancelledBy], ["cancelled", "replaced"]);
      yield* Queue.take(fake.started);
      yield* Deferred.succeed(fake.gates[2]!, undefined);
      const shown = yield* blender.awaitJob({ threadId: THREAD, jobId: latest.id });
      assert.strictEqual(shown.result?.preview?.current, true);
      assert.strictEqual(jobs.length, 3);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("shows an agent's edit of the same version, and redoes a failed export on retry", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const fake = yield* gatedRun();
      let failNext = false;
      const { blender, jobs } = yield* startJobs({
        run: (job) =>
          failNext
            ? fs
                .writeFileString(
                  job.spec.resultPath,
                  JSON.stringify({ ok: false, message: "boom" }),
                )
                .pipe(Effect.orDie, Effect.as(exited(23)))
            : fake.run(job),
      });
      const edit = yield* blender.startJob(
        { ...scene, input: scene.path, script: "edit.py", outputs: ["preview"] },
        { notifyAgent: true },
      );
      assert.strictEqual((yield* blender.openScene(scene)).id, edit.id);
      yield* Queue.take(fake.started);
      yield* Effect.sync(() => {
        failNext = true;
      });
      yield* blender.cancelJob({ threadId: THREAD, jobId: edit.id });

      const failed = yield* blender.openScene(scene);
      assert.strictEqual(
        (yield* blender.awaitJob({ threadId: THREAD, jobId: failed.id })).status,
        "failed",
      );
      // A remount shows the same failure instead of exporting again.
      assert.strictEqual((yield* blender.openScene(scene)).id, failed.id);
      yield* Effect.sync(() => {
        failNext = false;
      });
      const retried = yield* blender.openScene({ ...scene, retry: true });
      assert.notStrictEqual(retried.id, failed.id);
      yield* Queue.take(fake.started);
      yield* Deferred.succeed(fake.gates[1]!, undefined);
      assert.strictEqual(
        (yield* blender.awaitJob({ threadId: THREAD, jobId: retried.id })).status,
        "succeeded",
      );
      assert.strictEqual(jobs.length, 3);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("makes only the opening thread relevant, and only for a scene it can open", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const disabled = yield* startJobs({ enabled: false });
      const off = yield* disabled.blender.openScene(scene).pipe(Effect.flip);
      assert.strictEqual(off._tag === "BlenderRequestError" ? off.reason : off._tag, "disabled");
      assert.isFalse(yield* disabled.blender.isRelevant(THREAD));

      const fake = yield* gatedRun();
      const { blender, jobs, root, stops, workspace } = yield* startJobs({ run: fake.run });
      yield* fs.symlink(path.join(root, "outside.blend"), path.join(workspace, "link.blend"));
      const reasons = yield* Effect.forEach(
        [
          { threadId: THREAD, path: "../outside.blend" },
          { threadId: THREAD, path: "link.blend" },
          { threadId: THREAD, path: "edit.py" },
          { threadId: THREAD, path: "models/missing.blend" },
          { threadId: ThreadId.make("thread-unknown"), path: scene.path },
        ],
        (request) =>
          blender.openScene(request).pipe(
            Effect.flip,
            Effect.map((error) =>
              error._tag === "BlenderRequestError" ? error.reason : error._tag,
            ),
          ),
      );
      assert.deepStrictEqual(reasons, [
        "path-not-allowed",
        "path-not-allowed",
        "path-not-allowed",
        "file-not-found",
        "thread-not-found",
      ]);
      assert.isFalse(yield* blender.isRelevant(THREAD));
      assert.strictEqual(jobs.length, 0);

      const changed = yield* Effect.forkChild(Stream.runHead(blender.relevanceChanges), {
        startImmediately: true,
      });
      const opened = yield* blender.openScene(scene);
      assert.isTrue(yield* blender.isRelevant(THREAD));
      assert.isFalse(yield* blender.isRelevant(OTHER_THREAD));
      yield* Fiber.join(changed);

      // Stopping a turn ends its export but keeps the tools; archiving the thread removes them.
      // Each stop ends a running export only after it has settled relevance.
      yield* Queue.take(fake.started);
      yield* Queue.offer(stops, { threadId: THREAD, at: opened.createdAt, forget: false });
      yield* blender.awaitJob({ threadId: THREAD, jobId: opened.id });
      assert.isTrue(yield* blender.isRelevant(THREAD));
      const reopened = yield* blender.openScene(scene);
      yield* Queue.take(fake.started);
      yield* Queue.offer(stops, { threadId: THREAD, forget: false });
      yield* blender.awaitJob({ threadId: THREAD, jobId: reopened.id });
      assert.isFalse(yield* blender.isRelevant(THREAD));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
