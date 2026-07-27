/**
 * The Reporter is an Effect service the runner emits structured events into.
 * Two implementations ship with the CLI: a plain line-oriented reporter for
 * non-interactive terminals / CI, and an opentui TUI for interactive use.
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { LogEntry } from "./Model.ts";

export type TestStatus = "pass" | "fail" | "skip" | "todo";

export interface TestMeta {
  /** Stable id: `<file> > <describe chain> > <name>`. */
  readonly id: string;
  readonly file: string;
  readonly titlePath: ReadonlyArray<string>;
  readonly name: string;
}

export interface TestResult {
  readonly status: TestStatus;
  readonly durationMs: number;
  /** Pretty-printed failure (message + relevant stack), if failed. */
  readonly error?: string | undefined;
  /** Buffered Effect log / Console output captured during the test. */
  readonly logs: ReadonlyArray<LogEntry>;
  /** Number of retries that were attempted before this result. */
  readonly retries: number;
}

export interface RunSummary {
  readonly files: number;
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly todo: number;
  readonly durationMs: number;
  readonly failures: ReadonlyArray<{ meta: TestMeta; result: TestResult }>;
  /**
   * Files that failed as a whole (import error, or a `beforeAll`/`afterAll`
   * hook failure) rather than through an individual test. Counted in
   * {@link failed} alongside `failures`.
   */
  readonly fileFailures: ReadonlyArray<{ file: string; error: string }>;
}

export type TestEvent =
  | { readonly _tag: "CollectStart"; readonly files: ReadonlyArray<string> }
  | {
      /** Import progress: one per file during the collection phase. */
      readonly _tag: "FileCollected";
      readonly file: string;
    }
  | {
      /**
       * Collection is complete; execution is about to begin. Carries the
       * full (filtered) test list for the whole run.
       */
      readonly _tag: "RunStart";
      readonly files: number;
      readonly tests: ReadonlyArray<TestMeta>;
    }
  | {
      readonly _tag: "FileStart";
      readonly file: string;
      /**
       * LIVE reference to the file's hook log buffer (deploy/destroy). The
       * runner appends to it as hooks execute — single-process, so reporters
       * may read it incrementally (e.g. the TUI tailing a detail pane).
       */
      readonly logs?: ReadonlyArray<LogEntry>;
    }
  | {
      /** A file-level hook (deploy/destroy) started running. */
      readonly _tag: "HookStart";
      readonly file: string;
      readonly hook: "beforeAll" | "afterAll";
    }
  | {
      readonly _tag: "HookEnd";
      readonly file: string;
      readonly hook: "beforeAll" | "afterAll";
    }
  | {
      readonly _tag: "FileEnd";
      readonly file: string;
      /** Buffered output of file-level hooks (deploy/destroy). */
      readonly logs: ReadonlyArray<LogEntry>;
      readonly error?: string | undefined;
    }
  | {
      readonly _tag: "TestStart";
      readonly test: TestMeta;
      /** LIVE reference to the test's captured-output buffer (see FileStart). */
      readonly logs?: ReadonlyArray<LogEntry>;
    }
  | {
      readonly _tag: "TestEnd";
      readonly test: TestMeta;
      readonly result: TestResult;
    }
  | { readonly _tag: "RunEnd"; readonly summary: RunSummary };

/**
 * Interactive control over a live (or finished) run. The runner hands this
 * to the Reporter so the TUI can retry and kill tests.
 *
 * Retries re-run the test body as-is: for files whose state was torn down by
 * `afterAll` (deploy-once suites) the retried body may fail on missing
 * infrastructure — `test.provider`-style self-contained tests retry cleanly.
 */
export interface RunController {
  /** Re-run a finished test. No-op while the test is still running/queued. */
  readonly retryTest: (id: string) => void;
  /** Re-run every finished test of a file. */
  readonly retryFile: (file: string) => void;
  /** Interrupt a currently-running test (reported as failed/killed). */
  readonly killTest: (id: string) => void;
}

export interface ReporterService {
  readonly emit: (event: TestEvent) => Effect.Effect<void>;
  /**
   * Runs after RunEnd. The plain reporter returns immediately; the TUI blocks
   * until the user quits so results can be inspected.
   */
  readonly waitForExit: (summary: RunSummary) => Effect.Effect<void>;
  /** Called once by the runner when interactive control becomes available. */
  readonly attachController?: (
    controller: RunController,
  ) => Effect.Effect<void>;
}

export class Reporter extends Context.Service<Reporter, ReporterService>()(
  "alchemy-test/Reporter",
) {}
