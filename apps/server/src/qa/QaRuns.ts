import {
  QaRun,
  QaRunError,
  type PreviewAutomationActionEvent,
  type PreviewAutomationConsoleEntry,
  type PreviewAutomationNetworkEntry,
  type QaEvidenceRecordInput,
  type QaRunDeleteInput,
  type QaRunDeleteResult,
  type QaRunsSnapshot,
  type QaScenario,
  type ThreadId,
} from "@t3tools/contracts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { toSafeThreadAttachmentSegment } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import {
  QA_MAX_SCENARIOS_PER_RUN,
  QA_MAX_SCREENSHOT_BYTES,
  resolveVerdict,
  sanitizeConsoleEntries,
  sanitizeNetworkEntries,
  scenarioFileStem,
  stepsFor,
  summarizeLogs,
} from "./qaEvidence.ts";
import { QA_VIDEO_FILE, renderHtmlReport, renderMarkdownReport } from "./qaReport.ts";

/** What the browser showed when the agent recorded a verdict. */
export interface QaPageCapture {
  readonly url: string | null;
  readonly title: string | null;
  readonly png: Uint8Array | null;
  readonly consoleEntries: ReadonlyArray<PreviewAutomationConsoleEntry>;
  readonly networkEntries: ReadonlyArray<PreviewAutomationNetworkEntry>;
  readonly actionTimeline: ReadonlyArray<PreviewAutomationActionEvent>;
}

export class QaRuns extends Context.Service<
  QaRuns,
  {
    /** The thread's unfinished run, started now if it has none. */
    readonly ensureRun: (
      threadId: ThreadId,
      input: { readonly site: string | null },
    ) => Effect.Effect<QaRun, QaRunError>;
    readonly openRun: (threadId: ThreadId) => Effect.Effect<QaRun | null, QaRunError>;
    readonly recordEvidence: (
      threadId: ThreadId,
      input: QaEvidenceRecordInput,
      page: QaPageCapture,
    ) => Effect.Effect<QaScenario, QaRunError>;
    readonly markRecordingStarted: (
      threadId: ThreadId,
      startedAt: string,
    ) => Effect.Effect<void, QaRunError>;
    /** Moves a finished recording into the open run's evidence folder. */
    readonly attachVideo: (
      threadId: ThreadId,
      input: { readonly sourcePath: string; readonly sizeBytes: number },
    ) => Effect.Effect<void, QaRunError>;
    readonly markVideoUnavailable: (
      threadId: ThreadId,
      reason: string,
    ) => Effect.Effect<void, QaRunError>;
    /** Writes both reports and closes the open run; null when there is none. */
    readonly finishRun: (threadId: ThreadId) => Effect.Effect<QaRun | null, QaRunError>;
    readonly list: (threadId: ThreadId) => Effect.Effect<ReadonlyArray<QaRun>, QaRunError>;
    readonly subscribe: (threadId: ThreadId) => Stream.Stream<QaRunsSnapshot, QaRunError>;
    readonly deleteRun: (input: QaRunDeleteInput) => Effect.Effect<QaRunDeleteResult, QaRunError>;
  }
>()("t3/qa/QaRuns") {}

const RunJson = Schema.fromJsonString(QaRun);
const decodeRunJson = Schema.decodeUnknownOption(RunJson);
const encodeRunJson = Schema.encodeEffect(RunJson);
const encodeLogJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const failure = (message: string) => (cause: unknown) => new QaRunError({ message, cause });

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const random = yield* SecureRandom.SecureRandom;
  const changes = yield* PubSub.unbounded<ThreadId>();
  const lock = yield* Semaphore.make(1);
  const cache = new Map<ThreadId, ReadonlyArray<QaRun>>();

  const qaRunsDir = path.join(config.stateDir, "qa-runs");
  const threadDir = (threadId: ThreadId) =>
    path.join(qaRunsDir, toSafeThreadAttachmentSegment(threadId) ?? "_unknown");

  const nowIso = Effect.map(Clock.currentTimeMillis, (millis) =>
    DateTime.formatIso(DateTime.makeUnsafe(millis)),
  );
  const platform = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>) =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );

  const load = Effect.fn("QaRuns.load")(
    function* (threadId: ThreadId) {
      const cached = cache.get(threadId);
      if (cached !== undefined) return cached;
      const dir = threadDir(threadId);
      const names = yield* fileSystem.readDirectory(dir).pipe(
        Effect.catchIf(
          (error) => error.reason._tag === "NotFound",
          () => Effect.succeed([] as Array<string>),
        ),
      );
      const runs: Array<QaRun> = [];
      for (const name of names) {
        const text = yield* fileSystem
          .readFileString(path.join(dir, name, "run.json"))
          .pipe(Effect.orElseSucceed(() => ""));
        const run = decodeRunJson(text);
        if (run._tag === "Some" && run.value.threadId === threadId) runs.push(run.value);
      }
      runs.sort((left, right) => right.startedAt.localeCompare(left.startedAt));
      cache.set(threadId, runs);
      return runs;
    },
    Effect.mapError(failure("Could not read the thread's QA runs.")),
  );

  const save = Effect.fn("QaRuns.save")(
    function* (run: QaRun) {
      yield* fileSystem.makeDirectory(path.join(run.dir, "evidence"), { recursive: true });
      yield* platform(
        writeFileStringAtomically({
          filePath: path.join(run.dir, "run.json"),
          contents: `${yield* encodeRunJson(run)}\n`,
        }),
      );
      const runs = yield* load(run.threadId);
      cache.set(run.threadId, [run, ...runs.filter((existing) => existing.runId !== run.runId)]);
      yield* PubSub.publish(changes, run.threadId);
      return run;
    },
    Effect.mapError(failure("Could not save the QA run.")),
  );

  const findOpen = (runs: ReadonlyArray<QaRun>) => runs.find((run) => run.finishedAt === null);

  const ensureRunUnlocked = Effect.fnUntraced(function* (threadId: ThreadId, site: string | null) {
    const open = findOpen(yield* load(threadId));
    if (open) return open.site === null && site !== null ? yield* save({ ...open, site }) : open;
    const startedAt = yield* nowIso;
    const unique = (yield* random.uuidV4()).slice(0, 6);
    const runId = `${startedAt.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}-${unique}`;
    return yield* save({
      runId,
      threadId,
      site,
      startedAt,
      finishedAt: null,
      dir: path.join(threadDir(threadId), runId),
      scenarios: [],
      recordingStartedAt: null,
      video: null,
      videoUnavailableReason: null,
      reportMarkdownPath: null,
      reportHtmlPath: null,
    });
  });

  const updateOpenUnlocked = Effect.fnUntraced(function* (
    threadId: ThreadId,
    update: (run: QaRun) => QaRun,
  ) {
    const open = findOpen(yield* load(threadId));
    if (open) yield* save(update(open));
  });

  const recordEvidenceUnlocked = Effect.fnUntraced(function* (
    threadId: ThreadId,
    input: QaEvidenceRecordInput,
    page: QaPageCapture,
  ) {
    const run = yield* ensureRunUnlocked(threadId, page.url);
    if (run.scenarios.length >= QA_MAX_SCENARIOS_PER_RUN) {
      return yield* new QaRunError({
        message: `A run holds at most ${QA_MAX_SCENARIOS_PER_RUN} scenarios. Finish this run with qa_report_finish first.`,
      });
    }
    const index = run.scenarios.length;
    const since = run.scenarios.at(-1)?.recordedAt ?? run.startedAt;
    const evidenceDir = path.join(run.dir, "evidence");
    const stem = scenarioFileStem(index, input.scenario);
    const png =
      page.png !== null && page.png.byteLength <= QA_MAX_SCREENSHOT_BYTES ? page.png : null;
    const screenshotPath = png === null ? null : path.join(evidenceDir, `${stem}.png`);
    const consoleEntries = sanitizeConsoleEntries(page.consoleEntries);
    const networkEntries = sanitizeNetworkEntries(page.networkEntries);
    const consolePath = path.join(evidenceDir, `${stem}.console.json`);
    const networkPath = path.join(evidenceDir, `${stem}.network.json`);
    yield* Effect.gen(function* () {
      yield* fileSystem.makeDirectory(evidenceDir, { recursive: true });
      if (screenshotPath !== null && png !== null) yield* fileSystem.writeFile(screenshotPath, png);
      yield* fileSystem.writeFileString(consolePath, yield* encodeLogJson(consoleEntries));
      yield* fileSystem.writeFileString(networkPath, yield* encodeLogJson(networkEntries));
    }).pipe(Effect.mapError(failure("Could not save the scenario's evidence.")));
    const recordedAt = yield* nowIso;
    const { verdict, downgradeReason } = resolveVerdict(input.verdict, screenshotPath !== null);
    const scenario: QaScenario = {
      index,
      scenario: input.scenario,
      verdict,
      ...(downgradeReason === undefined
        ? {}
        : { requestedVerdict: input.verdict, downgradeReason }),
      note: input.note,
      ...(input.expected === undefined ? {} : { expected: input.expected }),
      ...(input.actual === undefined ? {} : { actual: input.actual }),
      ...(input.severity === undefined ? {} : { severity: input.severity }),
      steps: [...stepsFor(input, page.actionTimeline, since)],
      pageUrl: page.url,
      pageTitle: page.title,
      recordedAt,
      videoOffsetMs:
        run.recordingStartedAt === null
          ? null
          : Math.max(0, Date.parse(recordedAt) - Date.parse(run.recordingStartedAt)),
      screenshotPath,
      consolePath,
      networkPath,
      ...summarizeLogs(consoleEntries, networkEntries, since),
    };
    yield* save({ ...run, scenarios: [...run.scenarios, scenario] });
    return scenario;
  });

  const attachVideoUnlocked = Effect.fnUntraced(
    function* (
      threadId: ThreadId,
      input: { readonly sourcePath: string; readonly sizeBytes: number },
    ) {
      const open = findOpen(yield* load(threadId));
      if (!open) {
        yield* fileSystem.remove(input.sourcePath).pipe(Effect.ignore);
        return;
      }
      const target = path.join(open.dir, "evidence", QA_VIDEO_FILE);
      yield* fileSystem.makeDirectory(path.dirname(target), { recursive: true });
      // A rename fails across devices, so fall back to copying.
      yield* fileSystem
        .rename(input.sourcePath, target)
        .pipe(
          Effect.catch(() =>
            fileSystem
              .copyFile(input.sourcePath, target)
              .pipe(Effect.andThen(fileSystem.remove(input.sourcePath).pipe(Effect.ignore))),
          ),
        );
      yield* save({
        ...open,
        video: { path: target, sizeBytes: input.sizeBytes },
        videoUnavailableReason: null,
      });
    },
    Effect.mapError(failure("Could not save the run's video.")),
  );

  const finishRunUnlocked = Effect.fnUntraced(function* (threadId: ThreadId) {
    const open = findOpen(yield* load(threadId));
    if (!open) return null;
    const finishedAt = yield* nowIso;
    const reportMarkdownPath = path.join(open.dir, "report.md");
    const reportHtmlPath = path.join(open.dir, "report.html");
    const finished: QaRun = {
      ...open,
      finishedAt,
      videoUnavailableReason:
        open.video === null
          ? (open.videoUnavailableReason ?? "No recording was made during this run.")
          : null,
      reportMarkdownPath,
      reportHtmlPath,
    };
    const screenshots = new Map<string, string>();
    for (const scenario of finished.scenarios) {
      if (scenario.screenshotPath === null) continue;
      const bytes = yield* fileSystem
        .readFile(scenario.screenshotPath)
        .pipe(Effect.orElseSucceed(() => null));
      if (bytes !== null)
        screenshots.set(scenario.screenshotPath, Buffer.from(bytes).toString("base64"));
    }
    yield* fileSystem.writeFileString(reportMarkdownPath, renderMarkdownReport(finished)).pipe(
      Effect.andThen(
        fileSystem.writeFileString(
          reportHtmlPath,
          renderHtmlReport(finished, (screenshotPath) => screenshots.get(screenshotPath) ?? null),
        ),
      ),
      Effect.mapError(failure("Could not write the QA report.")),
    );
    return yield* save(finished);
  });

  const deleteRunUnlocked = Effect.fnUntraced(function* (input: QaRunDeleteInput) {
    const runs = yield* load(input.threadId);
    const run = runs.find((candidate) => candidate.runId === input.runId);
    if (!run) return yield* new QaRunError({ message: "That QA run no longer exists." });
    yield* fileSystem
      .remove(path.join(threadDir(input.threadId), input.runId), { recursive: true })
      .pipe(Effect.mapError(failure("Could not delete the QA run.")));
    cache.set(
      input.threadId,
      runs.filter((candidate) => candidate.runId !== input.runId),
    );
    yield* PubSub.publish(changes, input.threadId);
    return { runId: input.runId };
  });

  // The helpers above run under these methods' spans and the lock they take.
  const list = Effect.fn("QaRuns.list")(function* (threadId: ThreadId) {
    return yield* lock.withPermit(load(threadId));
  });

  return QaRuns.of({
    ensureRun: Effect.fn("QaRuns.ensureRun")(function* (threadId, input) {
      return yield* lock.withPermit(ensureRunUnlocked(threadId, input.site));
    }),
    openRun: Effect.fn("QaRuns.openRun")(function* (threadId) {
      return findOpen(yield* lock.withPermit(load(threadId))) ?? null;
    }),
    recordEvidence: Effect.fn("QaRuns.recordEvidence")(function* (threadId, input, page) {
      return yield* lock.withPermit(recordEvidenceUnlocked(threadId, input, page));
    }),
    markRecordingStarted: Effect.fn("QaRuns.markRecordingStarted")(function* (threadId, startedAt) {
      yield* lock.withPermit(
        updateOpenUnlocked(threadId, (run) => ({
          ...run,
          recordingStartedAt: run.recordingStartedAt ?? startedAt,
        })),
      );
    }),
    attachVideo: Effect.fn("QaRuns.attachVideo")(function* (threadId, input) {
      yield* lock.withPermit(attachVideoUnlocked(threadId, input));
    }),
    markVideoUnavailable: Effect.fn("QaRuns.markVideoUnavailable")(function* (threadId, reason) {
      yield* lock.withPermit(
        updateOpenUnlocked(threadId, (run) =>
          run.video === null ? { ...run, videoUnavailableReason: reason } : run,
        ),
      );
    }),
    finishRun: Effect.fn("QaRuns.finishRun")(function* (threadId) {
      return yield* lock.withPermit(finishRunUnlocked(threadId));
    }),
    list,
    subscribe: (threadId) =>
      Stream.unwrap(
        Effect.gen(function* () {
          // Subscribe before reading so a change in between is not lost.
          const subscription = yield* PubSub.subscribe(changes);
          const snapshot = Effect.map(list(threadId), (runs) => ({ runs }));
          return Stream.concat(
            Stream.fromEffect(snapshot),
            Stream.fromSubscription(subscription).pipe(
              Stream.filter((changed) => changed === threadId),
              Stream.mapEffect(() => snapshot),
            ),
          );
        }),
      ),
    deleteRun: Effect.fn("QaRuns.deleteRun")(function* (input) {
      return yield* lock.withPermit(deleteRunUnlocked(input));
    }),
  });
});

export const layer = Layer.effect(QaRuns, make);
