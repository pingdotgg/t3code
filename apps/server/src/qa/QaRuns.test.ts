import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import { QA_MAX_SCREENSHOT_BYTES } from "./qaEvidence.ts";
import * as QaRuns from "./QaRuns.ts";

const threadId = ThreadId.make("thread-qa-1");
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

const page = (overrides: Partial<QaRuns.QaPageCapture> = {}): QaRuns.QaPageCapture => ({
  url: "https://shop.test/login",
  title: "Login",
  png: PNG,
  consoleEntries: [{ level: "error", text: "Uncaught TypeError: x is undefined", timestamp: "t" }],
  networkEntries: [
    {
      url: "https://shop.test/api/login?session=abc",
      method: "POST",
      status: 500,
      failed: false,
      timestamp: "t",
    },
  ],
  actionTimeline: [],
  ...overrides,
});

let randomSeed = 0;
const withQaRuns = <A, E>(
  body: Effect.Effect<A, E, QaRuns.QaRuns | FileSystem.FileSystem | Path.Path>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "exploro-qa-runs-" });
    return yield* body.pipe(
      Effect.provide(
        QaRuns.layer.pipe(
          Layer.provide(ServerConfig.layerTest(process.cwd(), baseDir)),
          Layer.provide(
            Layer.succeed(
              SecureRandom.SecureRandom,
              SecureRandom.make((size) => new Uint8Array(size).fill((randomSeed += 1))),
            ),
          ),
        ),
      ),
    );
  });

it.layer(NodeServices.layer)("QaRuns", (it) => {
  it.effect("writes the manifest, evidence and self-contained reports", () =>
    withQaRuns(
      Effect.gen(function* () {
        const qaRuns = yield* QaRuns.QaRuns;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const scenario = yield* qaRuns.recordEvidence(
          threadId,
          {
            scenario: "Wrong password is rejected",
            verdict: "FAIL",
            note: "Server error instead of a message",
            severity: "major",
            steps: ["Open /login", "Submit a wrong password"],
          },
          page(),
        );
        assert.strictEqual(scenario.verdict, "FAIL");
        assert.strictEqual(scenario.consoleErrorCount, 1);
        assert.strictEqual(scenario.failedRequestCount, 1);
        assert.strictEqual(
          scenario.failedRequests[0]?.url,
          "https://shop.test/api/login?session=REDACTED",
        );
        assert.deepStrictEqual(yield* fs.readFile(scenario.screenshotPath!), PNG);

        const finished = yield* qaRuns.finishRun(threadId);
        assert.isNotNull(finished);
        const manifest = JSON.parse(yield* fs.readFileString(path.join(finished!.dir, "run.json")));
        assert.strictEqual(manifest.scenarios[0].scenario, "Wrong password is rejected");
        assert.isNotNull(manifest.finishedAt);
        assert.strictEqual(
          path.basename(scenario.screenshotPath!),
          "01-wrong-password-is-rejected.png",
        );

        const html = yield* fs.readFileString(finished!.reportHtmlPath!);
        assert.include(html, "data:image/png;base64,");
        assert.include(html, "video unavailable");
        assert.notMatch(html, /(?:src|href)="(?:https?:)?\/\//);
        const markdown = yield* fs.readFileString(finished!.reportMarkdownPath!);
        assert.include(markdown, "FAIL 1");
      }),
    ),
  );

  it.effect("downgrades a verdict without a usable screenshot", () =>
    withQaRuns(
      Effect.gen(function* () {
        const qaRuns = yield* QaRuns.QaRuns;
        const missing = yield* qaRuns.recordEvidence(
          threadId,
          { scenario: "Login works", verdict: "PASS", note: "Dashboard shown" },
          page({ png: null }),
        );
        const oversized = yield* qaRuns.recordEvidence(
          threadId,
          { scenario: "Logout works", verdict: "FAIL", note: "Still signed in" },
          page({ png: new Uint8Array(QA_MAX_SCREENSHOT_BYTES + 1) }),
        );
        for (const scenario of [missing, oversized]) {
          assert.strictEqual(scenario.verdict, "INCONCLUSIVE");
          assert.isNull(scenario.screenshotPath);
        }
        assert.strictEqual(missing.requestedVerdict, "PASS");
        assert.strictEqual(oversized.requestedVerdict, "FAIL");
      }),
    ),
  );

  it.effect("starts a new run after one finishes, and deletes a run with its folder", () =>
    withQaRuns(
      Effect.gen(function* () {
        const qaRuns = yield* QaRuns.QaRuns;
        const fs = yield* FileSystem.FileSystem;
        const input = { scenario: "Home loads", verdict: "PASS", note: "ok" } as const;
        yield* qaRuns.recordEvidence(threadId, input, page());
        const first = yield* qaRuns.finishRun(threadId);
        yield* qaRuns.recordEvidence(threadId, input, page());
        const runs = yield* qaRuns.list(threadId);
        assert.strictEqual(runs.length, 2);
        assert.isNull(runs.find((run) => run.runId !== first!.runId)?.finishedAt);

        yield* qaRuns.deleteRun({ threadId, runId: first!.runId });
        assert.isFalse(yield* fs.exists(first!.dir));
        assert.deepStrictEqual(
          (yield* qaRuns.list(threadId)).map((run) => run.runId),
          runs.filter((run) => run.runId !== first!.runId).map((run) => run.runId),
        );
      }),
    ),
  );
});
