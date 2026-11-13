import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import { serverSubcommand } from "../cli/serverSubcommand.ts";
import {
  makeUsageTranscriptWorker,
  USAGE_TRANSCRIPT_WORKER_COMMAND,
} from "./usageTranscriptWorker.ts";

it.live("settles a parse leased before the worker exited", () =>
  Effect.gen(function* () {
    const command = yield* serverSubcommand(USAGE_TRANSCRIPT_WORKER_COMMAND, 2048).pipe(
      Effect.provideService(HostProcess.Environment, {
        ...process.env,
        NODE_OPTIONS: `--import=data:text/javascript,${encodeURIComponent(
          "process.send({ ready: true }, () => process.exit(9)); await new Promise(() => {});",
        )}`,
      }),
    );
    const worker = yield* Effect.acquireRelease(
      Effect.sync(() => makeUsageTranscriptWorker(command)),
      (worker) => Effect.promise(() => worker.stop()),
    );
    assert.isTrue(yield* Effect.promise(() => worker.ready));
    yield* Effect.promise(() => worker.exited);
    assert.isUndefined(
      yield* Effect.raceFirst(
        worker.parse({ path: "unused", provider: "codex", resumeFrom: undefined }),
        Effect.promise(() => worker.exited).pipe(Effect.as("still waiting after exit")),
      ),
    );
  }),
);

it.live.each([
  { name: "disconnect", action: "process.disconnect()" },
  {
    name: "invalid envelope",
    action: "process.send({ invalid: true }); process.send({ result: null })",
  },
  { name: "invalid result", action: 'process.send({ result: "invalid" })' },
])("settles the job and stops the worker after $name", ({ action }) =>
  Effect.gen(function* () {
    const script = `process.on("message", () => { ${action} });
      process.send({ ready: true }); await new Promise(() => {});`;
    const command = yield* serverSubcommand(USAGE_TRANSCRIPT_WORKER_COMMAND, 2048).pipe(
      Effect.provideService(HostProcess.Environment, {
        ...process.env,
        NODE_OPTIONS: `--import=data:text/javascript,${encodeURIComponent(script)}`,
      }),
    );
    const worker = yield* Effect.acquireRelease(
      Effect.sync(() => makeUsageTranscriptWorker(command)),
      (worker) => Effect.promise(() => worker.stop()),
    );
    assert.isTrue(yield* Effect.promise(() => worker.ready));
    assert.isUndefined(
      yield* worker.parse({ path: "unused", provider: "codex", resumeFrom: undefined }),
    );
    yield* Effect.promise(() => worker.exited);
    assert.isUndefined(
      yield* worker.parse({ path: "unused", provider: "codex", resumeFrom: undefined }),
    );
  }),
);

it.live("settles a job when the IPC send throws", () =>
  Effect.gen(function* () {
    const command = yield* serverSubcommand(USAGE_TRANSCRIPT_WORKER_COMMAND, 2048);
    const worker = yield* Effect.acquireRelease(
      Effect.sync(() => makeUsageTranscriptWorker(command)),
      (worker) => Effect.promise(() => worker.stop()),
    );
    assert.isTrue(yield* Effect.promise(() => worker.ready));
    assert.isUndefined(
      yield* worker.parse({
        get path(): string {
          throw new Error("Cannot serialize the job");
        },
        provider: "codex",
        resumeFrom: undefined,
      }),
    );
    yield* Effect.promise(() => worker.exited);
  }),
);

it.live("stops a worker that ignores SIGTERM", () =>
  Effect.gen(function* () {
    const command = yield* serverSubcommand(USAGE_TRANSCRIPT_WORKER_COMMAND, 2048).pipe(
      Effect.provideService(HostProcess.Environment, {
        ...process.env,
        NODE_OPTIONS: `--import=data:text/javascript,${encodeURIComponent(
          'process.on("SIGTERM", () => {}); process.on("disconnect", () => process.exit(0)); process.send({ ready: true }); await new Promise(() => {});',
        )}`,
      }),
    );
    const worker = yield* Effect.acquireRelease(
      Effect.sync(() => makeUsageTranscriptWorker(command)),
      (worker) => Effect.promise(() => worker.stop()),
    );
    assert.isTrue(yield* Effect.promise(() => worker.ready));
    yield* Effect.promise(() => worker.stop());
    yield* Effect.promise(() => worker.stop());
    assert.isUndefined(
      yield* worker.parse({ path: "unused", provider: "codex", resumeFrom: undefined }),
    );
  }),
);
