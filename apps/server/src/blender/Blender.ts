import {
  BLENDER_INSPECT_MAX_OBJECTS,
  BLENDER_JOB_DEFAULT_TIMEOUT_SECONDS,
  BLENDER_MINIMUM_VERSION,
  BlenderJobId,
  CommandId,
  MessageId,
  BlenderRequestError,
  BlenderSceneObject,
  isBlenderJobTerminal,
  type BlenderScene,
  type BlenderExecutableSource,
  type BlenderJob,
  type BlenderJobEvent,
  type BlenderJobFailureReason,
  type BlenderJobOutput,
  type BlenderJobRef,
  type BlenderOpenSceneInput,
  type BlenderProbeFailure,
  type BlenderRequestErrorReason,
  type BlenderSceneInput,
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
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import { USER_STOP_REASON } from "../orchestration-v2/RunExecutionService.ts";
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
const PREVIEW_MARKER = /^T3_BLENDER_PREVIEW ([1-9]\d{0,2})\r?$/gm;
const MAX_ACTIVE_JOBS = 24;
const MAX_RETAINED_JOBS = 24;
const MAX_RELEVANT_THREADS = 256;

/**
 * The environment's Blender integration. Jobs belong to a thread, outlive their request, end with
 * the thread's Stop, archive or delete, and keep outputs private for asset URLs. Settings, caller
 * permissions and the workspace govern jobs; relevance only lists the tools to a thread's agent.
 */
export class Blender extends Context.Service<
  Blender,
  {
    /** Resolves and probes Blender with `--version`. Never spawns while the integration is off. */
    readonly status: Effect.Effect<BlenderStatus, ServerSettingsError>;
    /** Summarizes a `.blend` in the thread's workspace without writing it. */
    readonly inspect: (
      input: BlenderSceneInput,
    ) => Effect.Effect<BlenderScene, BlenderRequestError | ServerSettingsError>;
    /**
     * Marks the thread relevant and returns the job whose preview shows the `.blend` as it is now.
     * The same file version and Blender always return the same job, unless `retry` redoes a failed
     * export; a new version starts one preview-only export and cancels the one it replaces.
     */
    readonly openScene: (
      input: BlenderOpenSceneInput,
    ) => Effect.Effect<BlenderJob, BlenderRequestError | ServerSettingsError>;
    /** Whether the integration is on and the thread opened a scene. */
    readonly isRelevant: (threadId: ThreadId) => Effect.Effect<boolean>;
    /** Emits when a thread becomes relevant or stops being so. */
    readonly relevanceChanges: Stream.Stream<void>;
    /** Queues a job and returns at once; its state then arrives through `streamThreadJobs`. */
    readonly startJob: (
      input: BlenderStartJobInput,
      options?: { readonly notifyAgent?: boolean },
    ) => Effect.Effect<BlenderJob, BlenderRequestError | ServerSettingsError>;
    readonly getJob: (ref: BlenderJobRef) => Effect.Effect<BlenderJob, BlenderRequestError>;
    /** Ends a queued or running job and its processes. A finished job is returned unchanged. */
    readonly cancelJob: (ref: BlenderJobRef) => Effect.Effect<BlenderJob, BlenderRequestError>;
    /** Waits for the job to finish, however it ends. */
    readonly awaitJob: (ref: BlenderJobRef) => Effect.Effect<BlenderJob, BlenderRequestError>;
    readonly streamThreadJobs: (threadId: ThreadId) => Stream.Stream<BlenderJobEvent>;
    /** A retained, complete job output, for minting its asset URL. */
    readonly outputFile: (
      ref: BlenderJobRef & { readonly output: BlenderJobOutput; readonly revision?: number },
    ) => Effect.Effect<string, BlenderRequestError>;
  }
>()("t3/blender/Blender") {}

/** A thread event that ends the thread's jobs; `forget` also drops their retained outputs. */
export interface BlenderThreadStop {
  readonly threadId: ThreadId;
  /** Set for a Stop request, which ends jobs created by then; unset when the thread itself ended. */
  readonly at?: number;
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
    previewRevision: Schema.optionalKey(Schema.Number),
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
  const stop = (forget: boolean) => ({ threadId: event.threadId, forget });
  switch (event.type) {
    case "thread.archived":
      return stop(false);
    case "thread.deleted":
      return stop(true);
    case "turn-item.updated":
      return event.payload.type === "run_interrupt_request" &&
        event.payload.unresponsiveAt === undefined &&
        event.payload.message === USER_STOP_REASON
        ? { ...stop(false), at: DateTime.toEpochMillis(event.occurredAt) }
        : null;
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
  /** The input file's modification time and size when the job copied it, and the Blender run. */
  readonly sourceVersion: string | undefined;
  /** Started by opening the scene rather than by an agent. */
  readonly opened: boolean;
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

const RENDER_FILE = "render.png";
const jobTarget = (threadId: ThreadId, file: string | undefined) => `${threadId}\u0000${file}`;
const previewFile = (revision: number) => `preview-${revision}.glb`;

const make = Effect.fn("Blender.make")(function* (options: {
  readonly threads: BlenderThreads;
  readonly rootDir: string;
  readonly limits: BlenderLimits;
  readonly onAgentJobCompleted?: (job: BlenderJob) => Effect.Effect<void>;
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
    const staging = yield* Semaphore.make(1);
    const updates = yield* PubSub.unbounded<Exclude<BlenderJobEvent, { _tag: "Snapshot" }>>();
    const publishUpdate = (job: BlenderJob) => PubSub.publish(updates, { _tag: "Updated", job });
    const jobs = new Map<BlenderJobId, JobEntry>();
    // Executables whose version a probe accepted, so jobs do not probe again.
    const verified = new Set<string>();
    // The newest job sequence that published a preview, per target.
    const currentPreview = new Map<string, number>();
    let sequence = 0;
    const relevant = new Set<ThreadId>();
    const relevanceChanges = yield* PubSub.sliding<void>(1);
    let preparing: { readonly threadId: ThreadId; readonly at: number; stopped: boolean } | null =
      null;

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

    const inspect = Effect.fn("Blender.inspect")(function* (input: BlenderSceneInput) {
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
      if (jobs.has(entry.job.id)) yield* publishUpdate(entry.job);
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
      const protectCurrent = (a: JobEntry, b: JobEntry) =>
        Number(b.job.result?.preview?.current === true) -
        Number(a.job.result?.preview?.current === true);
      const oldest = [...jobs.values()]
        .filter((entry) => isBlenderJobTerminal(entry.job))
        .sort((a, b) => protectCurrent(a, b) || b.job.sequence - a.job.sequence)
        .slice(MAX_RETAINED_JOBS);
      const expired = finished.toSorted(protectCurrent).slice(limits.retainedJobsPerThread);
      for (const entry of new Set([...expired, ...oldest])) {
        jobs.delete(entry.job.id);
        yield* PubSub.publish(updates, {
          _tag: "Removed",
          threadId: entry.job.threadId,
          jobId: entry.job.id,
        });
        if (![...jobs.values()].some((remaining) => remaining.target === entry.target)) {
          currentPreview.delete(entry.target);
        }
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
      if (bytes <= limits.outputBytes) {
        const header = yield* fs.open(file).pipe(
          Effect.flatMap((handle) => handle.readAlloc(output === "preview" ? 12 : 8)),
          Effect.scoped,
          Effect.map(Option.map((bytes) => Buffer.from(bytes))),
          Effect.orElseSucceed(Option.none<Buffer>),
        );
        if (Option.isNone(header)) return null;
        const data = header.value;
        const complete =
          output === "preview"
            ? data.length === 12 &&
              data.toString("ascii", 0, 4) === GLB_MAGIC &&
              data.readUInt32LE(4) === 2 &&
              data.readUInt32LE(8) === bytes
            : data.toString("hex") === "89504e470d0a1a0a";
        if (!complete) return null;
      }
      return bytes;
    });

    const publishPreview = Effect.fn("Blender.publishPreview")(function* (
      entry: JobEntry,
      revision: number,
    ) {
      if (!Number.isInteger(revision) || revision < 1 || revision > 256)
        return "output-missing" as const;
      const file = path.join(entry.dir, "out", previewFile(revision));
      const bytes = yield* checkOutput("preview", file);
      if (bytes === null) return "output-missing" as const;
      if (bytes > limits.outputBytes) return "output-too-large" as const;
      if (
        entry.job.status !== "running" ||
        revision <= (entry.job.result?.preview?.revision ?? 0)
      ) {
        return null;
      }
      const previousSequence = currentPreview.get(entry.target);
      const current = previousSequence === undefined || previousSequence <= entry.job.sequence;
      const previous =
        current && previousSequence !== undefined && previousSequence !== entry.job.sequence
          ? [...jobs.values()].find((other) => other.job.sequence === previousSequence)
          : undefined;
      if (current) currentPreview.set(entry.target, entry.job.sequence);
      entry.job = {
        ...entry.job,
        result: { ...entry.job.result, preview: { bytes, current, revision } },
      };
      const previousPreview = previous?.job.result?.preview;
      if (previous !== undefined && previousPreview?.current === true) {
        previous.job = {
          ...previous.job,
          result: { ...previous.job.result, preview: { ...previousPreview, current: false } },
        };
      }
      yield* publishUpdate(entry.job);
      if (previous !== undefined && previousPreview?.current === true) {
        yield* publishUpdate(previous.job);
      }
      return null;
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

    const runJob = (
      entry: JobEntry,
      plan: JobPlan,
      root: string,
      ready: Deferred.Deferred<void>,
      notifyAgent: boolean,
    ) =>
      jobSlots
        .withPermit(
          Effect.gen(function* () {
            yield* Deferred.await(ready);
            if (entry.job.status !== "queued") return;
            yield* publishJob(entry, { status: "running", startedAt: yield* now });
            const work = path.join(entry.dir, "work");
            const out = path.join(entry.dir, "out");
            const previews = yield* Queue.sliding<number>(1);
            let tail = "";
            const receivePreviews = Stream.fromQueue(previews).pipe(
              Stream.runForEach((revision) => publishPreview(entry, revision)),
              Effect.andThen(Effect.never),
            );
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
                ...(entry.job.outputs.includes("preview")
                  ? {
                      onStdoutChunk: (chunk: Uint8Array) => {
                        const text = tail + Buffer.from(chunk).toString("utf8");
                        const end = text.lastIndexOf("\n") + 1;
                        for (const match of text.slice(0, end).matchAll(PREVIEW_MARKER)) {
                          Queue.offerUnsafe(previews, Number(match[1]));
                        }
                        tail = text.slice(end).slice(-32);
                      },
                    }
                  : {}),
              })
              .pipe(Effect.option, Effect.raceFirst(receivePreviews));
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
            const { previewRevision } = report.value;
            if (entry.job.outputs.includes("preview")) {
              const failure =
                previewRevision === undefined
                  ? "output-missing"
                  : yield* publishPreview(entry, previewRevision);
              if (failure !== null || entry.job.result?.preview?.revision !== previewRevision) {
                return yield* failJob(
                  entry,
                  failure ?? "output-missing",
                  failure === "output-too-large"
                    ? "The exported GLB is too large."
                    : "No complete GLB was produced.",
                );
              }
            }
            let renderBytes: number | null = null;
            if (entry.job.outputs.includes("render")) {
              renderBytes = yield* checkOutput("render", path.join(out, RENDER_FILE));
              if (renderBytes === null) {
                return yield* failJob(entry, "output-missing", "No render PNG was produced.");
              }
              if (renderBytes > limits.outputBytes) {
                return yield* failJob(entry, "output-too-large", "The rendered PNG is too large.");
              }
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
                yield* publishJob(entry, {
                  status: "succeeded",
                  finishedAt: yield* now,
                  result: {
                    ...entry.job.result,
                    ...(renderBytes === null ? {} : { render: { bytes: renderBytes } }),
                    ...(entry.job.saveAs === undefined ? {} : { saved: entry.job.saveAs }),
                  },
                });
              }),
            );
          }),
        )
        .pipe(
          // Waiters resume after the process exits and only complete outputs remain.
          Effect.ensuring(
            Effect.suspend(() =>
              Effect.gen(function* () {
                const preview = entry.job.result?.preview;
                if (entry.job.status !== "succeeded" && preview === undefined) {
                  yield* removeDir(entry.dir);
                } else {
                  yield* removeDir(path.join(entry.dir, "work"));
                  const out = path.join(entry.dir, "out");
                  const files = yield* fs.readDirectory(out).pipe(Effect.orElseSucceed(() => []));
                  for (const file of files) {
                    if (
                      (preview !== undefined && file === previewFile(preview.revision)) ||
                      (entry.job.result?.render !== undefined && file === RENDER_FILE)
                    ) {
                      continue;
                    }
                    yield* removeDir(path.join(out, file));
                  }
                }
                yield* Deferred.succeed(entry.done, entry.job);
                if (
                  notifyAgent &&
                  (entry.job.status === "succeeded" || entry.job.status === "failed")
                ) {
                  yield* options.onAgentJobCompleted?.(entry.job) ?? Effect.void;
                }
              }),
            ),
          ),
        );

    const fileVersion = (file: string) =>
      fs.stat(file).pipe(
        Effect.map((info) => `${Option.getOrUndefined(info.mtime)?.getTime()}:${info.size}`),
        Effect.mapError(() => requestError("file-not-found", "Could not read the job's input.")),
      );

    /** Checks a job request against settings and the thread's workspace. */
    const resolveJob = Effect.fn("Blender.resolveJob")(function* (input: BlenderStartJobInput) {
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
      const sourceVersion =
        source === undefined ? undefined : `${yield* fileVersion(source)}\u0000${executablePath}`;
      return { executablePath, root, source, script, saveAs, sourceVersion };
    });

    /** Stages a resolved job's inputs and queues it. Runs inside `staged`. */
    const queueJob = Effect.fn("Blender.queueJob")(function* (
      input: BlenderStartJobInput,
      resolved: Effect.Success<ReturnType<typeof resolveJob>>,
      origin: { readonly notifyAgent: boolean; readonly opened: boolean },
    ) {
      const { executablePath, root, source, script, saveAs } = resolved;
      const active = [...jobs.values()].filter((entry) => !isBlenderJobTerminal(entry.job));
      if (
        active.length >= MAX_ACTIVE_JOBS ||
        active.filter((entry) => entry.job.threadId === input.threadId).length >=
          limits.activeJobsPerThread
      ) {
        return yield* requestError("too-many-jobs");
      }

      const id = BlenderJobId.make(yield* random.uuidV4());
      const dir = path.join(jobsDir, id);
      const work = path.join(dir, "work");
      const out = path.join(dir, "out");
      const outputs = [...new Set(input.outputs)];
      const preparation = { threadId: input.threadId, at: yield* now, stopped: false };
      preparing = preparation;
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
          createdAt: preparation.at,
          status: "queued",
        },
        dir,
        target: jobTarget(input.threadId, source ?? script),
        sourceVersion: resolved.sourceVersion,
        opened: origin.opened,
        done: yield* Deferred.make<BlenderJob>(),
        fiber: undefined,
        finishing: false,
      };
      const ready = yield* Deferred.make<void>();
      const currentRoot = yield* threadRoot(input.threadId).pipe(
        Effect.onError(() => removeDir(dir)),
      );
      if (currentRoot !== root) {
        yield* removeDir(dir);
        return yield* requestError(
          "path-not-allowed",
          "The thread's workspace moved while preparing the job.",
        );
      }
      return yield* Effect.gen(function* () {
        const queued = entry.job;
        const fiber = yield* runJob(
          entry,
          {
            executablePath,
            cwd: root,
            hasInput: source !== undefined,
            saveAs,
            timeoutSeconds: input.timeoutSeconds ?? BLENDER_JOB_DEFAULT_TIMEOUT_SECONDS,
          },
          root,
          ready,
          origin.notifyAgent,
        ).pipe(Effect.forkIn(layerScope, { startImmediately: true }));
        if (preparation.stopped) {
          yield* Fiber.interrupt(fiber);
          return yield* requestError(
            "invalid-request",
            "The thread stopped while preparing the job.",
          );
        }
        entry.fiber = fiber;
        jobs.set(id, entry);
        yield* publishUpdate(queued);
        yield* Deferred.succeed(ready, undefined);
        return queued;
      }).pipe(Effect.uninterruptible);
    });

    /** One request stages at a time, so concurrent requests see each other's queued jobs. */
    const staged = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      staging.withPermit(
        effect.pipe(
          Effect.ensuring(
            Effect.sync(() => {
              preparing = null;
            }),
          ),
        ),
      );

    const startJob = Effect.fn("Blender.startJob")(function* (
      input: BlenderStartJobInput,
      requestOptions?: { readonly notifyAgent?: boolean },
    ) {
      const resolved = yield* resolveJob(input);
      return yield* queueJob(input, resolved, {
        notifyAgent: requestOptions?.notifyAgent === true,
        opened: false,
      });
    }, staged);

    const markRelevant = (threadId: ThreadId) =>
      Effect.suspend(() => {
        const known = relevant.delete(threadId);
        relevant.add(threadId);
        for (const oldest of relevant) {
          if (relevant.size <= MAX_RELEVANT_THREADS) break;
          relevant.delete(oldest);
        }
        return known ? Effect.void : PubSub.publish(relevanceChanges, undefined);
      });

    const openScene = Effect.fn("Blender.openScene")(
      function* (input: BlenderOpenSceneInput) {
        const request = {
          threadId: input.threadId,
          input: input.path,
          outputs: ["preview" as const],
        };
        const resolved = yield* resolveJob(request);
        yield* markRelevant(input.threadId);
        const target = jobTarget(input.threadId, resolved.source);
        const previews = [...jobs.values()]
          .filter((entry) => entry.target === target && entry.job.outputs.includes("preview"))
          .toSorted((a, b) => b.job.sequence - a.job.sequence);
        // A job of this version that shows or will show its preview: an agent's edit counts
        // unless it failed before publishing one, and a cancelled export is started again.
        const reusable = previews.find(
          (entry) =>
            entry.sourceVersion === resolved.sourceVersion &&
            entry.job.status !== "cancelled" &&
            (entry.job.status !== "failed" ||
              (input.retry !== true && (entry.opened || entry.job.result?.preview !== undefined))),
        );
        if (reusable !== undefined) return { job: reusable.job, replaced: [] };
        const replaced = previews.filter(
          (entry) => entry.opened && !isBlenderJobTerminal(entry.job),
        );
        const job = yield* queueJob(request, resolved, { notifyAgent: false, opened: true });
        return { job, replaced };
      },
      staged,
      Effect.tap(({ replaced }) =>
        Effect.forEach(replaced, (entry) => cancelEntry(entry, "replaced"), { discard: true }),
      ),
      Effect.map(({ job }) => job),
    );

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
      if (entry.finishing || isBlenderJobTerminal(entry.job)) {
        yield* Deferred.await(entry.done);
        return entry.job;
      }
      yield* publishJob(entry, { status: "cancelled", cancelledBy, finishedAt: yield* now });
      // Interrupting the job's fiber ends its Blender process tree before this returns.
      if (entry.fiber !== undefined) yield* Fiber.interrupt(entry.fiber);
      yield* Deferred.await(entry.done);
      return entry.job;
    });

    const cancelThread = Effect.fn("Blender.cancelThread")(function* (stop: BlenderThreadStop) {
      if (stop.at === undefined && relevant.delete(stop.threadId)) {
        yield* PubSub.publish(relevanceChanges, undefined);
      }
      if (
        preparing?.threadId === stop.threadId &&
        (stop.at === undefined || preparing.at <= stop.at)
      ) {
        preparing.stopped = true;
      }
      const owned = [...jobs.values()].filter((entry) => entry.job.threadId === stop.threadId);
      // A deleted thread's jobs leave the index first, so no request finds them meanwhile.
      if (stop.forget) for (const entry of owned) jobs.delete(entry.job.id);
      yield* Effect.forEach(
        owned.filter((entry) => stop.at === undefined || entry.job.createdAt <= stop.at),
        (entry) => cancelEntry(entry, "thread-stopped"),
        { concurrency: "unbounded", discard: true },
      );
      if (stop.forget) {
        for (const entry of owned) {
          if (![...jobs.values()].some((remaining) => remaining.target === entry.target)) {
            currentPreview.delete(entry.target);
          }
          yield* removeDir(entry.dir);
        }
      }
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
                Stream.filter((event) =>
                  event._tag === "Updated"
                    ? event.job.threadId === threadId
                    : event.threadId === threadId,
                ),
              ),
            ),
          );
        }),
      );

    return Blender.of({
      status,
      inspect,
      openScene,
      isRelevant: Effect.fn("Blender.isRelevant")(function* (threadId) {
        if (!relevant.has(threadId)) return false;
        const enabled = yield* settings.getSettings.pipe(
          Effect.map(({ blender }) => blender.enabled),
          Effect.orElseSucceed(() => false),
        );
        // Archiving or eviction may land while settings load.
        return enabled && relevant.has(threadId);
      }),
      relevanceChanges: Stream.fromPubSub(relevanceChanges),
      startJob,
      getJob: Effect.fn("Blender.getJob")(function* (ref) {
        return (yield* findJob(ref)).job;
      }),
      cancelJob: Effect.fn("Blender.cancelJob")(function* (ref) {
        return yield* cancelEntry(yield* findJob(ref), "request");
      }),
      awaitJob: Effect.fn("Blender.awaitJob")(function* (ref) {
        const entry = yield* findJob(ref);
        yield* Deferred.await(entry.done);
        return entry.job;
      }),
      streamThreadJobs,
      outputFile: Effect.fn("Blender.outputFile")(function* (ref) {
        const { job, dir } = yield* findJob(ref);
        if (ref.output === "preview") {
          const preview = job.result?.preview;
          if (
            preview === undefined ||
            (ref.revision !== undefined && ref.revision !== preview.revision)
          ) {
            return yield* requestError("job-not-found");
          }
          return path.join(dir, "out", previewFile(preview.revision));
        }
        if (job.result?.render === undefined) return yield* requestError("job-not-found");
        return path.join(dir, "out", RENDER_FILE);
      }),
    });
  }
});

/** Wires jobs to a test's threads and folder. */
export const layerWith = (options: {
  readonly threads: BlenderThreads;
  readonly rootDir: string;
  readonly limits?: Partial<BlenderLimits>;
  readonly onAgentJobCompleted?: (job: BlenderJob) => Effect.Effect<void>;
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
    const onAgentJobCompleted = Effect.fn("Blender.onAgentJobCompleted")(function* (
      job: BlenderJob,
    ) {
      const succeeded = job.status === "succeeded";
      const summary = succeeded ? "Blender job finished" : "Blender job failed";
      yield* engine
        .dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`server:blender-job:${job.id}`),
          threadId: job.threadId,
          messageId: MessageId.make(`message:blender-job:${job.id}`),
          text: `${summary}. Read blender_job with jobId ${job.id} for the result and output links.`,
          notification: {
            source: { kind: "background_task" },
            outcome: succeeded ? "completed" : "failed",
            summary,
          },
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "agent",
          creationSource: "server",
        })
        .pipe(
          Effect.catch((error) =>
            Effect.logWarning("Blender job completion delivery failed", { reason: error._tag }),
          ),
        );
    });
    return layerWith({
      threads,
      rootDir: path.join(config.stateDir, "blender"),
      onAgentJobCompleted,
    });
  }),
);
