import {
  BLENDER_INSPECT_MAX_OBJECTS,
  BLENDER_JOB_DEFAULT_TIMEOUT_SECONDS,
  BLENDER_MINIMUM_VERSION,
  BlenderJobId,
  BlenderRequestError,
  BlenderSceneObject,
  isBlenderJobTerminal,
  type BlenderScene,
  type BlenderExecutableSource,
  type BlenderInspectInput,
  type BlenderJob,
  type BlenderJobEvent,
  type BlenderJobFailureReason,
  type BlenderJobOutput,
  type BlenderJobRef,
  type BlenderProbeFailure,
  type BlenderRequestErrorReason,
  type BlenderStartJobInput,
  type BlenderStatus,
  type OrchestrationV2DomainEvent,
  type ServerSettingsError,
  type ThreadId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveCommandPath } from "@t3tools/shared/shell";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import { isWithinRoot } from "../workspace/KnownWorkspaces.ts";
import { BLENDER_JOB_SCRIPT } from "./jobScript.ts";

const PROBE_TIMEOUT = "15 seconds";
const PROBE_MAX_OUTPUT_BYTES = 64 * 1024;
// Blender may print startup warnings before its version line.
const VERSION_LINE = /^Blender (\d+)\.(\d+)(?:\.(\d+))?/m;
// The job script re-raises a failure, which `--python-exit-code` turns into this status.
const SCRIPT_FAILURE_EXIT_CODE = 23;
const GLB_MAGIC = "glTF";

/**
 * The environment's Blender integration, for settings, clients and agents alike. Jobs belong to
 * a thread, run in a background Blender, outlive their request, end when the thread is stopped,
 * archived or deleted, and keep outputs privately for authenticated asset URLs.
 */
export class Blender extends Context.Service<
  Blender,
  {
    /** Resolves and probes Blender with `--version`. Never spawns while the integration is off. */
    readonly status: Effect.Effect<BlenderStatus, ServerSettingsError>;
    /** Summarizes a `.blend` in the thread's workspace without writing it. */
    readonly inspect: (
      input: BlenderInspectInput,
    ) => Effect.Effect<BlenderScene, BlenderRequestError | ServerSettingsError>;
    /** Queues a job and returns at once; its state then arrives through `streamThreadJobs`. */
    readonly startJob: (
      input: BlenderStartJobInput,
    ) => Effect.Effect<BlenderJob, BlenderRequestError | ServerSettingsError>;
    readonly getJob: (ref: BlenderJobRef) => Effect.Effect<BlenderJob, BlenderRequestError>;
    /** Ends a queued or running job and its processes. A finished job is returned unchanged. */
    readonly cancelJob: (ref: BlenderJobRef) => Effect.Effect<BlenderJob, BlenderRequestError>;
    /** Waits for the job to finish, however it ends. */
    readonly awaitJob: (ref: BlenderJobRef) => Effect.Effect<BlenderJob, BlenderRequestError>;
    readonly streamThreadJobs: (threadId: ThreadId) => Stream.Stream<BlenderJobEvent>;
    /** The retained file of a succeeded job's output, for minting its asset URL. */
    readonly outputFile: (
      ref: BlenderJobRef & { readonly output: BlenderJobOutput },
    ) => Effect.Effect<string, BlenderRequestError>;
  }
>()("t3/blender/Blender") {}

/** A thread event that ends the thread's jobs; `forget` also drops their retained outputs. */
export interface BlenderThreadStop {
  readonly threadId: ThreadId;
  readonly at: number;
  readonly forget: boolean;
}

/** What jobs need from orchestration. */
export interface BlenderThreads {
  /** The workspace root of a live thread, or null when it is unknown, archived or deleted. */
  readonly workspaceRoot: (threadId: ThreadId) => Effect.Effect<string | null>;
  readonly stops: Stream.Stream<BlenderThreadStop>;
}

export interface BlenderLimits {
  readonly runningJobs: number;
  /** Queued and running jobs one thread may have. */
  readonly activeJobsPerThread: number;
  /** Finished jobs kept per thread; older ones and their outputs are removed. */
  readonly retainedJobsPerThread: number;
  readonly outputBytes: number;
  readonly logBytes: number;
  readonly inspectTimeout: Duration.Input;
}

const DEFAULT_LIMITS: BlenderLimits = {
  runningJobs: 2,
  activeJobsPerThread: 8,
  retainedJobsPerThread: 10,
  outputBytes: 512 * 1024 * 1024,
  logBytes: 1024 * 1024,
  inspectTimeout: "60 seconds",
};

const JobReport = Schema.Union([
  Schema.Struct({
    ok: Schema.Literal(true),
    scene: Schema.optionalKey(
      Schema.Struct({ objects: Schema.Array(BlenderSceneObject), objectCount: Schema.Number }),
    ),
  }),
  Schema.Struct({ ok: Schema.Literal(false), message: Schema.String }),
]);
const decodeJobReport = Schema.decodeUnknownOption(Schema.fromJsonString(JobReport));

const requestError = (reason: BlenderRequestErrorReason, detail?: string) =>
  new BlenderRequestError({ reason, ...(detail === undefined ? {} : { detail }) });

/** Thread events that end a thread's jobs: Stop (an interrupt request), archive and delete. */
const threadStopFromEvent = (event: OrchestrationV2DomainEvent): BlenderThreadStop | null => {
  const stop = (forget: boolean) => ({
    threadId: event.threadId,
    at: DateTime.toEpochMillis(event.occurredAt),
    forget,
  });
  switch (event.type) {
    case "thread.archived":
      return stop(false);
    case "thread.deleted":
      return stop(true);
    case "turn-item.updated":
      return event.payload.type === "run_interrupt_request" ? stop(false) : null;
    default:
      return null;
  }
};

interface ResolvedExecutable {
  readonly executablePath: string;
  readonly source: BlenderExecutableSource;
}

const versionAtLeast = (major: number, minor: number) =>
  major > BLENDER_MINIMUM_VERSION.major ||
  (major === BLENDER_MINIMUM_VERSION.major && minor >= BLENDER_MINIMUM_VERSION.minor);

/** Standard install locations after PATH, most specific first. */
const standardInstallCandidates = Effect.fn("Blender.standardInstallCandidates")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const home = yield* HostProcess.HomeDirectory;
  const env = yield* HostProcess.Environment;
  switch (platform) {
    case "darwin":
      return [
        "/Applications/Blender.app/Contents/MacOS/Blender",
        path.join(home, "Applications", "Blender.app", "Contents", "MacOS", "Blender"),
      ];
    case "win32": {
      // Installers put each release in its own "Blender X.Y" folder; prefer the newest.
      const roots = [env.ProgramFiles, env["ProgramFiles(x86)"]].flatMap((root) =>
        root ? [path.join(root, "Blender Foundation")] : [],
      );
      const candidates: string[] = [];
      for (const root of roots) {
        const releases = (yield* fs.readDirectory(root).pipe(Effect.orElseSucceed(() => [])))
          .flatMap((name) => {
            const match = /^Blender (\d+)\.(\d+)$/.exec(name);
            return match ? [{ name, major: Number(match[1]), minor: Number(match[2]) }] : [];
          })
          .toSorted((a, b) => b.major - a.major || b.minor - a.minor);
        candidates.push(...releases.map(({ name }) => path.join(root, name, "blender.exe")));
      }
      return candidates;
    }
    default:
      return [
        "/snap/bin/blender",
        "/var/lib/flatpak/exports/bin/org.blender.Blender",
        path.join(home, ".local", "share", "flatpak", "exports", "bin", "org.blender.Blender"),
        "/opt/blender/blender",
      ];
  }
});

/** An override is used as given and never falls back to detection. */
const resolveExecutable = Effect.fn("Blender.resolveExecutable")(function* (override: string) {
  if (override.length > 0) {
    const executablePath = yield* resolveCommandPath(override);
    return executablePath === null
      ? null
      : ({ executablePath, source: "override" } satisfies ResolvedExecutable);
  }
  const onPath = yield* resolveCommandPath("blender");
  if (onPath !== null)
    return { executablePath: onPath, source: "path" } satisfies ResolvedExecutable;
  for (const candidate of yield* standardInstallCandidates()) {
    const executablePath = yield* resolveCommandPath(candidate);
    if (executablePath !== null) {
      return { executablePath, source: "standard-install" } satisfies ResolvedExecutable;
    }
  }
  return null;
});

interface JobEntry {
  job: BlenderJob;
  /** Private to this job: `work` holds its inputs, `out` its outputs. */
  readonly dir: string;
  /** Jobs with the same target replace each other's preview. */
  readonly target: string;
  readonly done: Deferred.Deferred<BlenderJob>;
  fiber: Fiber.Fiber<void> | undefined;
  /** Set once the job commits to succeeding; cancelling then waits for the result instead. */
  finishing: boolean;
}

interface JobPlan {
  readonly executablePath: string;
  readonly cwd: string;
  readonly hasInput: boolean;
  readonly saveAs: string | undefined;
  readonly timeoutSeconds: number;
}

const OUTPUT_FILES: Record<BlenderJobOutput, string> = {
  preview: "preview.glb",
  render: "render.png",
};

const make = Effect.fn("Blender.make")(function* (options: {
  readonly threads: BlenderThreads;
  readonly rootDir: string;
  readonly limits: BlenderLimits;
}) {
  {
    const settings = yield* ServerSettings.ServerSettingsService;
    const runner = yield* ProcessRunner.ProcessRunner;
    const random = yield* SecureRandom.SecureRandom;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const layerScope = yield* Scope.Scope;
    const { threads, limits } = options;
    // Probes start on client request, so concurrent reads share one Blender process at a time.
    const probeLock = yield* Semaphore.make(1);
    const jobSlots = yield* Semaphore.make(limits.runningJobs);
    const updates = yield* PubSub.unbounded<BlenderJob>();
    const jobs = new Map<BlenderJobId, JobEntry>();
    // Executables whose version a probe accepted, so jobs do not probe again.
    const verified = new Set<string>();
    // The newest job sequence that published a preview, per target.
    const currentPreview = new Map<string, number>();
    let sequence = 0;

    // Jobs live only in memory, so outputs of an earlier server run have no owner.
    const jobsDir = path.join(options.rootDir, "jobs");
    const userDir = path.join(options.rootDir, "user");
    const scriptPath = path.join(options.rootDir, "t3_blender_job.py");
    yield* fs.remove(jobsDir, { recursive: true, force: true }).pipe(Effect.ignore);
    yield* Effect.all([
      fs.makeDirectory(jobsDir, { recursive: true, mode: 0o700 }),
      fs.makeDirectory(userDir, { recursive: true, mode: 0o700 }),
    ]).pipe(Effect.ignore);
    yield* fs.writeFileString(scriptPath, BLENDER_JOB_SCRIPT, { mode: 0o600 }).pipe(Effect.ignore);
    // Keeps Blender off the user's own preferences and add-ons.
    const blenderEnv = {
      BLENDER_USER_CONFIG: path.join(userDir, "config"),
      BLENDER_USER_SCRIPTS: path.join(userDir, "scripts"),
      BLENDER_USER_DATAFILES: path.join(userDir, "datafiles"),
    };
    const blenderArgs = (input: string | undefined, specPath: string) => [
      "--background",
      "--factory-startup",
      "--disable-autoexec",
      ...(input === undefined ? [] : [input]),
      "--python-exit-code",
      String(SCRIPT_FAILURE_EXIT_CODE),
      "--python",
      scriptPath,
      "--",
      specPath,
    ];

    const probe = Effect.fn("Blender.probe")(function* (resolved: ResolvedExecutable) {
      const failed = (reason: BlenderProbeFailure, exitCode?: number): BlenderStatus => ({
        _tag: "ProbeFailed",
        ...resolved,
        reason,
        ...(exitCode === undefined ? {} : { exitCode }),
      });
      const output = yield* runner
        .run({
          command: resolved.executablePath,
          args: ["--version"],
          timeout: PROBE_TIMEOUT,
          timeoutBehavior: "timedOutResult",
          maxOutputBytes: PROBE_MAX_OUTPUT_BYTES,
          outputMode: "truncate",
        })
        .pipe(
          Effect.tapError((error) => Effect.logInfo("Blender probe failed", { tag: error._tag })),
          Effect.option,
        );
      if (output._tag === "None") return failed("spawn-failed");
      const { timedOut, code, stdout } = output.value;
      if (timedOut) return failed("timed-out");
      if (code !== 0) return failed("nonzero-exit", code === null ? undefined : Number(code));
      const match = VERSION_LINE.exec(stdout);
      if (match === null) return failed("unrecognized-output");
      const [, major = "", minor = "", patch] = match;
      const version = [major, minor, ...(patch === undefined ? [] : [patch])].join(".");
      return versionAtLeast(Number(major), Number(minor))
        ? ({ _tag: "Available", ...resolved, version } satisfies BlenderStatus)
        : ({
            _tag: "Unsupported",
            ...resolved,
            version,
            minimumVersion: `${BLENDER_MINIMUM_VERSION.major}.${BLENDER_MINIMUM_VERSION.minor}`,
          } satisfies BlenderStatus);
    });

    /** Probes the configured executable; `trustVerified` skips the probe for one already accepted. */
    const resolveStatus = Effect.fn("Blender.resolveStatus")(function* (trustVerified: boolean) {
      const { blender } = yield* settings.getSettings;
      if (!blender.enabled) return { _tag: "Disabled" } satisfies BlenderStatus;
      const resolved = yield* resolveExecutable(blender.executablePath).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
      );
      if (resolved === null) {
        return {
          _tag: "NotFound",
          source: blender.executablePath.length > 0 ? "override" : "detection",
        } satisfies BlenderStatus;
      }
      if (trustVerified && verified.has(resolved.executablePath)) {
        return { _tag: "Available", ...resolved, version: "verified" } satisfies BlenderStatus;
      }
      const probed = yield* probeLock.withPermit(probe(resolved));
      if (probed._tag === "Available") verified.add(resolved.executablePath);
      else verified.delete(resolved.executablePath);
      return probed;
    });

    const status = resolveStatus(false).pipe(Effect.withSpan("Blender.status"));

    const executableForJobs = resolveStatus(true).pipe(
      Effect.flatMap((current) => {
        switch (current._tag) {
          case "Available":
            return Effect.succeed(current.executablePath);
          case "Disabled":
            return Effect.fail(requestError("disabled"));
          default:
            return Effect.fail(requestError("unavailable", current._tag));
        }
      }),
    );

    const realPath = (file: string) =>
      fs.realPath(file).pipe(Effect.option, Effect.map(Option.getOrNull));

    const threadRoot = Effect.fn("Blender.threadRoot")(function* (threadId: ThreadId) {
      const root = yield* threads.workspaceRoot(threadId);
      const canonical = root === null ? null : yield* realPath(root);
      if (canonical === null) return yield* requestError("thread-not-found");
      return canonical;
    });

    /** A file inside the workspace, after links; never a path that escapes it. */
    const workspaceFile = Effect.fn("Blender.workspaceFile")(function* (
      root: string,
      requested: string,
      extension: ".blend" | ".py",
    ) {
      const file = yield* realPath(path.resolve(root, requested));
      if (file === null) return yield* requestError("file-not-found", requested);
      if (!isWithinRoot(path, file, root) || path.extname(file).toLowerCase() !== extension) {
        return yield* requestError("path-not-allowed", requested);
      }
      const info = yield* fs.stat(file).pipe(Effect.option);
      if (Option.isNone(info) || info.value.type !== "File") {
        return yield* requestError("file-not-found", requested);
      }
      return file;
    });

    /** A new `.blend` path inside the workspace whose folder exists and which does not. */
    const saveTarget = Effect.fn("Blender.saveTarget")(function* (root: string, requested: string) {
      const requestedPath = path.resolve(root, requested);
      if (path.extname(requestedPath).toLowerCase() !== ".blend") {
        return yield* requestError("path-not-allowed", requested);
      }
      const folder = yield* realPath(path.dirname(requestedPath));
      if (folder === null) return yield* requestError("file-not-found", path.dirname(requested));
      const target = path.join(folder, path.basename(requestedPath));
      if (!isWithinRoot(path, target, root))
        return yield* requestError("path-not-allowed", requested);
      if (yield* fs.exists(target).pipe(Effect.orElseSucceed(() => true))) {
        return yield* requestError("save-target-exists", requested);
      }
      return target;
    });

    const relative = (root: string, file: string) => path.relative(root, file);

    const readReport = (file: string) =>
      fs.readFileString(file).pipe(
        Effect.option,
        Effect.map((text) => Option.flatMap(text, decodeJobReport)),
      );

    const lastLines = (text: string) =>
      text.trim().split(/\r?\n/).slice(-5).join("\n").slice(-1000);

    const writeSpec = (file: string, spec: Record<string, unknown>) =>
      fs.writeFileString(file, JSON.stringify(spec), { mode: 0o600 });

    const inspect = Effect.fn("Blender.inspect")(function* (input: BlenderInspectInput) {
      const executablePath = yield* executableForJobs;
      const root = yield* threadRoot(input.threadId);
      const file = yield* workspaceFile(root, input.path, ".blend");
      const dir = yield* fs
        .makeTempDirectoryScoped({ directory: jobsDir, prefix: "inspect-" })
        .pipe(Effect.mapError(() => requestError("inspection-failed", "staging")));
      const specPath = path.join(dir, "spec.json");
      const resultPath = path.join(dir, "result.json");
      yield* writeSpec(specPath, {
        resultPath,
        outputDir: dir,
        inspectLimit: BLENDER_INSPECT_MAX_OBJECTS,
      }).pipe(Effect.mapError(() => requestError("inspection-failed", "staging")));
      const output = yield* jobSlots
        .withPermit(
          runner.run({
            command: executablePath,
            args: blenderArgs(file, specPath),
            cwd: root,
            env: blenderEnv,
            timeout: limits.inspectTimeout,
            timeoutBehavior: "timedOutResult",
            maxOutputBytes: limits.logBytes,
            outputMode: "truncate",
          }),
        )
        .pipe(Effect.mapError((error) => requestError("inspection-failed", error._tag)));
      if (output.timedOut) return yield* requestError("inspection-failed", "timed-out");
      const report = yield* readReport(resultPath);
      if (Option.isNone(report) || !report.value.ok || report.value.scene === undefined) {
        const message =
          Option.isSome(report) && !report.value.ok
            ? report.value.message
            : lastLines(output.stderr || output.stdout);
        return yield* requestError("inspection-failed", message);
      }
      return { path: relative(root, file), ...report.value.scene } satisfies BlenderScene;
    }, Effect.scoped);

    const publishJob = Effect.fn("Blender.publishJob")(function* (
      entry: JobEntry,
      patch: Partial<BlenderJob>,
    ) {
      entry.job = { ...entry.job, ...patch };
      yield* PubSub.publish(updates, entry.job);
      if (!isBlenderJobTerminal(entry.job)) return;
      yield* retain(entry.job.threadId);
    });

    const removeDir = (dir: string) =>
      fs.remove(dir, { recursive: true, force: true }).pipe(Effect.ignore);

    /** Keeps the newest finished jobs of a thread and removes the rest with their outputs. */
    const retain = Effect.fn("Blender.retain")(function* (threadId: ThreadId) {
      const finished = [...jobs.values()]
        .filter((entry) => entry.job.threadId === threadId && isBlenderJobTerminal(entry.job))
        .toSorted((a, b) => b.job.sequence - a.job.sequence);
      for (const entry of finished.slice(limits.retainedJobsPerThread)) {
        jobs.delete(entry.job.id);
        yield* removeDir(entry.dir);
      }
    });

    const now = Effect.map(DateTime.now, DateTime.toEpochMillis);

    const failJob = Effect.fn("Blender.failJob")(function* (
      entry: JobEntry,
      reason: BlenderJobFailureReason,
      message: string,
      exitCode?: number,
    ) {
      if (entry.job.status !== "running") return;
      yield* publishJob(entry, {
        status: "failed",
        finishedAt: yield* now,
        failure: { reason, message, ...(exitCode === undefined ? {} : { exitCode }) },
      });
    });

    /** The published size of an output, or null when it is missing or not what it claims. */
    const checkOutput = Effect.fn("Blender.checkOutput")(function* (
      output: BlenderJobOutput,
      file: string,
    ) {
      const info = yield* fs.stat(file).pipe(Effect.option);
      if (Option.isNone(info) || info.value.type !== "File") return null;
      const bytes = Number(info.value.size);
      if (output === "preview") {
        const header = yield* fs.readFile(file).pipe(
          Effect.map((data) => new TextDecoder().decode(data.subarray(0, 4))),
          Effect.orElseSucceed(() => ""),
        );
        if (header !== GLB_MAGIC) return null;
      }
      return bytes;
    });

    /** Links the edited scene into the workspace; a file created there meanwhile is never replaced. */
    const publishSave = Effect.fn("Blender.publishSave")(function* (
      staged: string,
      target: string,
      root: string,
    ) {
      const folder = yield* realPath(path.dirname(target));
      if (folder === null || !isWithinRoot(path, path.join(folder, path.basename(target)), root)) {
        return "path-not-allowed" as const;
      }
      const partial = path.join(
        folder,
        `.${path.basename(target)}.t3-${path.basename(staged)}.partial`,
      );
      return yield* fs.copyFile(staged, partial).pipe(
        Effect.andThen(fs.link(partial, target)),
        Effect.as("saved" as const),
        Effect.catch((error) =>
          Effect.succeed(
            error.reason._tag === "AlreadyExists"
              ? ("save-target-exists" as const)
              : ("save-failed" as const),
          ),
        ),
        Effect.ensuring(fs.remove(partial, { force: true }).pipe(Effect.ignore)),
      );
    });

    const runJob = (entry: JobEntry, plan: JobPlan, root: string) =>
      jobSlots
        .withPermit(
          Effect.gen(function* () {
            if (entry.job.status !== "queued") return;
            yield* publishJob(entry, { status: "running", startedAt: yield* now });
            const work = path.join(entry.dir, "work");
            const out = path.join(entry.dir, "out");
            const output = yield* runner
              .run({
                command: plan.executablePath,
                args: blenderArgs(
                  plan.hasInput ? path.join(work, "input.blend") : undefined,
                  path.join(work, "spec.json"),
                ),
                cwd: plan.cwd,
                env: blenderEnv,
                timeout: `${plan.timeoutSeconds} seconds`,
                timeoutBehavior: "timedOutResult",
                maxOutputBytes: limits.logBytes,
                outputMode: "truncate",
              })
              .pipe(Effect.option);
            if (Option.isNone(output))
              return yield* failJob(entry, "spawn-failed", "Blender did not start.");
            if (output.value.timedOut) {
              return yield* failJob(entry, "timed-out", `Stopped after ${plan.timeoutSeconds} s.`);
            }
            const report = yield* readReport(path.join(work, "result.json"));
            const exitCode = output.value.code === null ? undefined : Number(output.value.code);
            if (exitCode !== 0 || Option.isNone(report) || !report.value.ok) {
              const message =
                Option.isSome(report) && !report.value.ok
                  ? report.value.message
                  : lastLines(output.value.stderr || output.value.stdout) || "Blender failed.";
              return yield* failJob(entry, "script-error", message, exitCode);
            }
            const sizes: Partial<Record<BlenderJobOutput, number>> = {};
            for (const kind of entry.job.outputs) {
              const bytes = yield* checkOutput(kind, path.join(out, OUTPUT_FILES[kind]));
              if (bytes === null) {
                return yield* failJob(
                  entry,
                  "output-missing",
                  `No ${OUTPUT_FILES[kind]} was written.`,
                );
              }
              if (bytes > limits.outputBytes) {
                return yield* failJob(
                  entry,
                  "output-too-large",
                  `${OUTPUT_FILES[kind]} is ${bytes} bytes.`,
                );
              }
              sizes[kind] = bytes;
            }
            // From here the job either succeeds or fails on its own; a cancel waits for that.
            yield* Effect.uninterruptible(
              Effect.gen(function* () {
                if (entry.job.status !== "running") return;
                entry.finishing = true;
                if (plan.saveAs !== undefined) {
                  const saved = yield* publishSave(
                    path.join(work, "scene.blend"),
                    plan.saveAs,
                    root,
                  );
                  if (saved !== "saved") {
                    return yield* failJob(
                      entry,
                      saved === "save-target-exists" ? "save-target-exists" : "output-missing",
                      saved === "save-target-exists"
                        ? `${entry.job.saveAs} was created while the job ran.`
                        : `${entry.job.saveAs} could not be written.`,
                    );
                  }
                }
                const previewIsCurrent =
                  sizes.preview !== undefined &&
                  (currentPreview.get(entry.target) ?? -1) < entry.job.sequence;
                if (previewIsCurrent) currentPreview.set(entry.target, entry.job.sequence);
                yield* publishJob(entry, {
                  status: "succeeded",
                  finishedAt: yield* now,
                  result: {
                    ...(sizes.preview === undefined
                      ? {}
                      : { preview: { bytes: sizes.preview, current: previewIsCurrent } }),
                    ...(sizes.render === undefined ? {} : { render: { bytes: sizes.render } }),
                    ...(entry.job.saveAs === undefined ? {} : { saved: entry.job.saveAs }),
                  },
                });
              }),
            );
          }),
        )
        .pipe(
          // Only a succeeded job's outputs are kept; inputs and partial files never are. Waiters
          // resume only here, once the process has exited and its files are settled.
          Effect.ensuring(
            Effect.suspend(() =>
              (entry.job.status === "succeeded"
                ? removeDir(path.join(entry.dir, "work"))
                : removeDir(entry.dir)
              ).pipe(Effect.andThen(Deferred.succeed(entry.done, entry.job))),
            ),
          ),
        );

    const startJob = Effect.fn("Blender.startJob")(function* (input: BlenderStartJobInput) {
      if (input.input === undefined && input.script === undefined) {
        return yield* requestError("invalid-request", "A job needs an input file or a script.");
      }
      const executablePath = yield* executableForJobs;
      const root = yield* threadRoot(input.threadId);
      const source =
        input.input === undefined ? undefined : yield* workspaceFile(root, input.input, ".blend");
      const script =
        input.script === undefined ? undefined : yield* workspaceFile(root, input.script, ".py");
      const saveAs = input.saveAs === undefined ? undefined : yield* saveTarget(root, input.saveAs);
      const active = [...jobs.values()].filter(
        (entry) => entry.job.threadId === input.threadId && !isBlenderJobTerminal(entry.job),
      ).length;
      if (active >= limits.activeJobsPerThread) return yield* requestError("too-many-jobs");

      const id = BlenderJobId.make(yield* random.uuidV4());
      const dir = path.join(jobsDir, id);
      const work = path.join(dir, "work");
      const out = path.join(dir, "out");
      const outputs = [...new Set(input.outputs)];
      // The input is copied now, so the job sees the file as it was when requested.
      yield* Effect.gen(function* () {
        yield* fs.makeDirectory(work, { recursive: true, mode: 0o700 });
        yield* fs.makeDirectory(out, { recursive: true, mode: 0o700 });
        if (source !== undefined) yield* fs.copyFile(source, path.join(work, "input.blend"));
        yield* writeSpec(path.join(work, "spec.json"), {
          resultPath: path.join(work, "result.json"),
          outputDir: out,
          outputs,
          ...(script === undefined ? {} : { script }),
          ...(saveAs === undefined ? {} : { savePath: path.join(work, "scene.blend") }),
        });
      }).pipe(
        Effect.onError(() => removeDir(dir)),
        Effect.mapError(() => requestError("file-not-found", "Could not stage the job's input.")),
      );

      const entry: JobEntry = {
        job: {
          id,
          threadId: input.threadId,
          sequence: sequence++,
          ...(source === undefined ? {} : { input: relative(root, source) }),
          ...(script === undefined ? {} : { script: relative(root, script) }),
          outputs,
          ...(saveAs === undefined ? {} : { saveAs: relative(root, saveAs) }),
          createdAt: yield* now,
          status: "queued",
        },
        dir,
        target: `${input.threadId}\u0000${source ?? script}`,
        done: yield* Deferred.make<BlenderJob>(),
        fiber: undefined,
        finishing: false,
      };
      jobs.set(id, entry);
      const queued = entry.job;
      yield* PubSub.publish(updates, queued);
      entry.fiber = yield* runJob(
        entry,
        {
          executablePath,
          cwd: root,
          hasInput: source !== undefined,
          saveAs,
          timeoutSeconds: input.timeoutSeconds ?? BLENDER_JOB_DEFAULT_TIMEOUT_SECONDS,
        },
        root,
        // Started at once, so a cancel that interrupts it still runs its cleanup.
      ).pipe(Effect.forkIn(layerScope, { startImmediately: true }));
      return queued;
    });

    const findJob = Effect.fn("Blender.findJob")(function* (ref: BlenderJobRef) {
      const entry = jobs.get(ref.jobId);
      if (entry === undefined || entry.job.threadId !== ref.threadId) {
        return yield* requestError("job-not-found");
      }
      return entry;
    });

    const cancelEntry = Effect.fn("Blender.cancelEntry")(function* (
      entry: JobEntry,
      cancelledBy: NonNullable<BlenderJob["cancelledBy"]>,
    ) {
      if (entry.finishing || isBlenderJobTerminal(entry.job))
        return yield* Deferred.await(entry.done);
      yield* publishJob(entry, { status: "cancelled", cancelledBy, finishedAt: yield* now });
      // Interrupting the job's fiber ends its Blender process tree before this returns.
      if (entry.fiber !== undefined) yield* Fiber.interrupt(entry.fiber);
      return yield* Deferred.await(entry.done);
    });

    const cancelThread = Effect.fn("Blender.cancelThread")(function* (stop: BlenderThreadStop) {
      const owned = [...jobs.values()].filter((entry) => entry.job.threadId === stop.threadId);
      // A deleted thread's jobs leave the index first, so no request finds them meanwhile.
      if (stop.forget) for (const entry of owned) jobs.delete(entry.job.id);
      yield* Effect.forEach(
        owned.filter((entry) => entry.job.createdAt <= stop.at),
        (entry) => cancelEntry(entry, "thread-stopped"),
        { concurrency: "unbounded", discard: true },
      );
      if (stop.forget) yield* Effect.forEach(owned, (entry) => removeDir(entry.dir));
    });

    yield* threads.stops.pipe(Stream.runForEach(cancelThread), Effect.forkIn(layerScope));

    const streamThreadJobs = (threadId: ThreadId) =>
      Stream.unwrap(
        Effect.gen(function* () {
          // Subscribed before the snapshot is read, so no change falls between the two.
          const subscription = yield* PubSub.subscribe(updates);
          const snapshot = [...jobs.values()]
            .filter((entry) => entry.job.threadId === threadId)
            .map((entry) => entry.job)
            .toSorted((a, b) => a.sequence - b.sequence);
          const first: BlenderJobEvent = { _tag: "Snapshot", jobs: snapshot };
          return Stream.make(first).pipe(
            Stream.concat(
              Stream.fromSubscription(subscription).pipe(
                Stream.filter((job) => job.threadId === threadId),
                Stream.map((job): BlenderJobEvent => ({ _tag: "Updated", job })),
              ),
            ),
          );
        }),
      );

    return Blender.of({
      status,
      inspect,
      startJob,
      getJob: Effect.fn("Blender.getJob")(function* (ref) {
        return (yield* findJob(ref)).job;
      }),
      cancelJob: Effect.fn("Blender.cancelJob")(function* (ref) {
        return yield* cancelEntry(yield* findJob(ref), "request");
      }),
      awaitJob: Effect.fn("Blender.awaitJob")(function* (ref) {
        return yield* Deferred.await((yield* findJob(ref)).done);
      }),
      streamThreadJobs,
      outputFile: Effect.fn("Blender.outputFile")(function* (ref) {
        const { job, dir } = yield* findJob(ref);
        if (job.status !== "succeeded" || !job.outputs.includes(ref.output)) {
          return yield* requestError("job-not-found");
        }
        return path.join(dir, "out", OUTPUT_FILES[ref.output]);
      }),
    });
  }
});

/** Wires jobs to a test's threads and folder. */
export const layerWith = (options: {
  readonly threads: BlenderThreads;
  readonly rootDir: string;
  readonly limits?: Partial<BlenderLimits>;
}) => Layer.effect(Blender, make({ ...options, limits: { ...DEFAULT_LIMITS, ...options.limits } }));

/** Server-lifetime: jobs outlive the connection that started them. */
export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const engine = yield* Orchestrator.OrchestratorV2;
    const projects = yield* ProjectStore.ProjectStoreV2;
    const path = yield* Path.Path;
    const threads: BlenderThreads = {
      workspaceRoot: (threadId) =>
        engine.getThreadRecords(threadId, []).pipe(
          Effect.flatMap(({ thread }) => {
            if (thread.deletedAt !== null || thread.archivedAt !== null)
              return Effect.succeed(null);
            if (thread.worktreePath !== null) return Effect.succeed(thread.worktreePath);
            return projects
              .get(thread.projectId)
              .pipe(
                Effect.map(
                  Option.match({ onNone: () => null, onSome: (project) => project.workspaceRoot }),
                ),
              );
          }),
          Effect.tapError((cause) =>
            Effect.logWarning("Blender could not read a thread", { threadId, cause }),
          ),
          Effect.orElseSucceed(() => null),
        ),
      stops: engine.streamDomainEvents.pipe(
        Stream.map(threadStopFromEvent),
        Stream.filter((stop) => stop !== null),
        Stream.tapError((cause) => Effect.logWarning("Blender lost thread events", { cause })),
        Stream.retry(Schedule.spaced("1 second")),
        // The retry never gives up; this only closes the error channel.
        Stream.catchCause(() => Stream.empty),
      ),
    };
    return layerWith({ threads, rootDir: path.join(config.stateDir, "blender") });
  }),
);
