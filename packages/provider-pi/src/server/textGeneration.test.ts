import { assert, it } from "@effect/vitest";
import { ProviderInstanceId, TextGenerationError } from "@t3tools/contracts";
import type {
  ReviewGuideGenerationInput,
  ReviewGuideGenerationResult,
} from "@t3tools/provider-core/server/textGeneration";
import { createModelSelection } from "@t3tools/shared/model";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { makePiTextGeneration } from "./textGeneration.ts";
import { PiSettings } from "../settings.ts";

const decodeJsonLine = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const encodeJsonLine = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodePiSettings = Schema.decodeUnknownSync(PiSettings);

const makeFakePi = (reply: string, setModelError?: string, settle = true) =>
  Effect.gen(function* () {
    const prompted = yield* Deferred.make<void>();
    const closed = yield* Deferred.make<void>();
    const launches: Array<ReadonlyArray<string>> = [];
    const stdout = yield* Queue.unbounded<Uint8Array, Cause.Done>();
    const received: Array<Record<string, unknown>> = [];
    const emit = (record: Record<string, unknown>) =>
      Queue.offer(stdout, new TextEncoder().encode(`${encodeJsonLine(record)}\n`));
    let buffered = "";
    const onStdin = (chunk: Uint8Array) =>
      Effect.gen(function* () {
        buffered += new TextDecoder().decode(chunk);
        const lines = buffered.split("\n");
        buffered = lines.pop() ?? "";
        for (const line of lines.filter((candidate) => candidate.length > 0)) {
          const record = decodeJsonLine(line) as Record<string, unknown>;
          received.push(record);
          const response = { type: "response", id: record["id"], command: record["type"] };
          if (record["type"] === "prompt") {
            yield* emit({ ...response, success: true });
            yield* Deferred.succeed(prompted, undefined);
            if (settle) yield* emit({ type: "agent_settled" });
          } else if (record["type"] === "get_last_assistant_text") {
            yield* emit({ ...response, success: true, data: { text: reply } });
          } else if (record["type"] === "set_model" && setModelError !== undefined) {
            yield* emit({ ...response, success: false, error: setModelError });
          } else {
            yield* emit({ ...response, success: true });
          }
        }
      });
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          assert(ChildProcess.isStandardCommand(command));
          launches.push(command.args);
          return ChildProcessSpawner.makeHandle({
            // Outside the valid pid range, so PiRpc's process-group kill never lands.
            pid: ChildProcessSpawner.ProcessId(999_999_999),
            exitCode: Effect.never,
            isRunning: Effect.succeed(true),
            kill: () => Effect.void,
            unref: Effect.succeed(Effect.void),
            stdin: Sink.forEach(onStdin),
            stdout: Stream.fromQueue(stdout),
            stderr: Stream.empty,
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
          });
        }),
        () => Deferred.succeed(closed, undefined),
      ),
    );
    return { spawner, received, launches, prompted, closed };
  });

const reviewInput = {
  cwd: process.cwd(),
  number: 1,
  title: "A fixture change",
  description: "Review the fixture change.",
  baseBranch: "main",
  baseCommit: "a".repeat(40),
  settledReview: "",
  modelSelection: createModelSelection(ProviderInstanceId.make("pi"), "default"),
} satisfies ReviewGuideGenerationInput;

const evidence = Effect.succeed({
  manifestPath: "/fixture/evidence/manifest.json",
  headCommit: "b".repeat(40),
});

const makeGeneration = (pi: Effect.Success<ReturnType<typeof makeFakePi>>) =>
  makePiTextGeneration(
    decodePiSettings({
      enabled: true,
      binaryPath: "pi",
      launchArgs: "--approve --tools bash,write --extension /fixture/unsafe.ts",
      customModels: [],
    }),
    {},
  ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, pi.spawner));

it.effect("names the model and the disabled extensions when Pi cannot load it", () =>
  Effect.gen(function* () {
    const pi = yield* makeFakePi("", "Model not found: demo/demo-model");
    const textGeneration = yield* makePiTextGeneration(
      { enabled: true, binaryPath: "pi", launchArgs: "", customModels: [] },
      {},
    ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, pi.spawner));

    const error = yield* textGeneration
      .generateCommitMessage({
        cwd: process.cwd(),
        branch: "main",
        stagedSummary: "M README.md",
        stagedPatch: "diff --git a/README.md b/README.md",
        modelSelection: createModelSelection(ProviderInstanceId.make("pi"), "demo/demo-model"),
      })
      .pipe(Effect.flip);

    assert.equal(error._tag, "TextGenerationError");
    assert.include(error.detail, "Pi rejected model 'demo/demo-model'");
    assert.include(error.detail, "Model not found: demo/demo-model");
    assert.include(error.detail, "--no-extensions");
    assert.isUndefined(pi.received.find((record) => record["type"] === "prompt"));
  }),
);

it.effect("generates a repository-aware review guide with Pi", () =>
  Effect.gen(function* () {
    const expected = {
      stops: [
        {
          title: "Replace the legacy entry point",
          summary: "The new entry point replaces the deleted one.",
          attention: null,
          excerpts: [
            { path: "added.ts", side: "new", start: 1, end: 3, caption: "New entry point" },
            { path: "deleted.ts", side: "old", start: 1, end: 3, caption: "Removed entry point" },
          ],
          files: [{ path: "empty.txt", note: "Empty fixture" }],
          notes: [],
          questions: [],
        },
      ],
    } satisfies ReviewGuideGenerationResult;
    const pi = yield* makeFakePi(JSON.stringify(expected));
    const textGeneration = yield* makeGeneration(pi);
    let prepared = 0;

    const guide = yield* textGeneration.generateReviewGuide({
      ...reviewInput,
      evidence: Effect.sync(() => {
        prepared++;
      }).pipe(Effect.andThen(evidence)),
    });

    assert.deepEqual(guide, expected);
    assert.equal(prepared, 1);
    const prompt = pi.received.find((record) => record["type"] === "prompt");
    assert.include(prompt?.["message"], "/fixture/evidence/manifest.json");
    assert.include(prompt?.["message"], reviewInput.baseCommit);
    assert.include(prompt?.["message"], "payloadOffset");
    assert.include(prompt?.["message"], "git diff <pinnedHead>...<layerHead> --");
    assert.include(prompt?.["message"], "An ancestor layer has an empty comparison");
    assert.deepEqual(pi.launches[0]?.slice(-5), [
      "--no-extensions",
      "--no-tools",
      "--no-approve",
      "--tools",
      "read,grep,find,ls",
    ]);
    const trustArgs = pi.launches[0]?.filter(
      (arg) => arg === "--approve" || arg === "--no-approve",
    );
    assert.deepEqual(trustArgs, ["--approve", "--no-approve"]);
    assert.isFalse(pi.launches[0]?.includes("/fixture/unsafe.ts"));
    assert.isTrue(yield* Deferred.isDone(pi.closed));
  }),
);

it.effect("refuses missing or failed evidence before starting Pi", () =>
  Effect.gen(function* () {
    const pi = yield* makeFakePi('{"stops":[]}');
    const generation = yield* makeGeneration(pi);
    const missing = yield* generation.generateReviewGuide(reviewInput).pipe(Effect.flip);
    assert.include(missing.detail, "host-prepared Git evidence");
    const failed = new TextGenerationError({
      operation: "generateReviewGuide",
      detail: "Evidence failed",
    });
    assert.strictEqual(
      yield* generation
        .generateReviewGuide({ ...reviewInput, evidence: Effect.fail(failed) })
        .pipe(Effect.flip),
      failed,
    );
    assert.deepEqual(pi.launches, []);
  }),
);

it.effect("allows the full investigation deadline and closes Pi on timeout", () =>
  Effect.gen(function* () {
    const pi = yield* makeFakePi("", undefined, false);
    const generation = yield* makeGeneration(pi);
    const fiber = yield* generation
      .generateReviewGuide({ ...reviewInput, evidence })
      .pipe(Effect.forkScoped);
    yield* Deferred.await(pi.prompted);
    yield* TestClock.adjust(180_000);
    assert.isFalse(yield* Deferred.isDone(pi.closed));
    yield* TestClock.adjust(720_000);
    const error = yield* Fiber.join(fiber).pipe(Effect.flip);
    assert.equal(error.detail, "Pi request timed out.");
    assert.isTrue(yield* Deferred.isDone(pi.closed));
  }),
);

it.effect("closes an active investigation when its caller is interrupted", () =>
  Effect.gen(function* () {
    const pi = yield* makeFakePi("", undefined, false);
    const generation = yield* makeGeneration(pi);
    const fiber = yield* generation
      .generateReviewGuide({ ...reviewInput, evidence })
      .pipe(Effect.forkScoped);
    yield* Deferred.await(pi.prompted);
    yield* Fiber.interrupt(fiber);
    assert.isTrue(yield* Deferred.isDone(pi.closed));
  }),
);

it.effect("keeps all four ordinary helpers tool-disabled and on the three-minute deadline", () =>
  Effect.gen(function* () {
    const pi = yield* makeFakePi(
      JSON.stringify({ subject: "A commit", body: "Body", title: "A title", branch: "a-branch" }),
    );
    const generation = yield* makeGeneration(pi);
    const common = { cwd: process.cwd(), modelSelection: reviewInput.modelSelection };
    yield* generation.generateCommitMessage({
      ...common,
      branch: "main",
      stagedSummary: "",
      stagedPatch: "",
    });
    yield* generation.generatePrContent({
      ...common,
      baseBranch: "main",
      headBranch: "feature",
      commitSummary: "",
      diffSummary: "",
      diffPatch: "",
    });
    yield* generation.generateBranchName({ ...common, message: "A branch" });
    yield* generation.generateThreadTitle({ ...common, message: "A title" });
    assert.equal(pi.launches.length, 4);
    for (const args of pi.launches) {
      assert.equal(args.at(-1), "--no-tools");
      assert.isFalse(args.includes("--tools"));
      assert.isFalse(args.includes("/fixture/unsafe.ts"));
    }
    const stalled = yield* makeFakePi("", undefined, false);
    const stalledGeneration = yield* makeGeneration(stalled);
    const fiber = yield* stalledGeneration
      .generateThreadTitle({ ...common, message: "A title" })
      .pipe(Effect.forkScoped);
    yield* Deferred.await(stalled.prompted);
    yield* TestClock.adjust(180_000);
    assert.equal((yield* Fiber.join(fiber).pipe(Effect.flip)).detail, "Pi request timed out.");
    assert.isTrue(yield* Deferred.isDone(stalled.closed));
  }),
);
