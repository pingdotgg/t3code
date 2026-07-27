/**
 * Core data model for the alchemy-test harness.
 *
 * A test file is collected into a tree of {@link Suite}s and {@link TestCase}s
 * by evaluating its module body (describe/test calls register nodes). The
 * runner then walks the tree and executes every test as an Effect.
 */
import type * as Effect from "effect/Effect";

/** Execution mode attached to a suite or test at registration time. */
export type Mode = "run" | "skip" | "only" | "todo";

/** A single log line captured from a test's Effect Logger or Console. */
export interface LogEntry {
  readonly level: string;
  readonly message: string;
  readonly time: Date;
}

/**
 * The body of a test. Always an Effect — plain-function tests are wrapped
 * at registration time. The Effect must be self-contained (R = never);
 * wrapping (scope, TestClock/TestConsole, shared layers) happens in the
 * harness closures, NOT in the runner.
 */
export type TestBody = () => Effect.Effect<unknown, unknown, never>;

/** A hook body. Same contract as {@link TestBody}. */
export type HookBody = () => Effect.Effect<unknown, unknown, never>;

export interface Hook {
  readonly body: HookBody;
  readonly timeout?: number | undefined;
}

export interface TestCase {
  readonly type: "test";
  readonly name: string;
  readonly mode: Mode;
  /** Invert the result: the test passes only if the body fails. */
  readonly fails?: boolean;
  /**
   * Run this test with the whole-process write lock: no other test in the
   * run executes concurrently with it. Required for tests that mutate
   * process-global state (e.g. `process.env.PATH`) — the runner executes
   * everything in ONE bun process, so such mutations are visible everywhere.
   */
  readonly exclusive?: boolean;
  /** Override the run-wide retry budget for this test. */
  readonly retry?: number | undefined;
  readonly timeout?: number | undefined;
  readonly body: TestBody | undefined;
  readonly parent: Suite;
}

export interface Suite {
  readonly type: "suite";
  readonly name: string;
  mode: Mode;
  /** When true, children run one at a time (the default; describe.concurrent opts out). */
  sequential: boolean;
  readonly children: Array<Suite | TestCase>;
  readonly beforeAll: Array<Hook>;
  readonly afterAll: Array<Hook>;
  readonly beforeEach: Array<Hook>;
  readonly afterEach: Array<Hook>;
  readonly parent: Suite | undefined;
}

/** The root suite of a single test file. */
export interface FileSuite extends Suite {
  /** Path relative to the run root, e.g. `test/Cloudflare/R2/Bucket.test.ts`. */
  readonly file: string;
}

export const makeSuite = (
  name: string,
  parent: Suite | undefined,
  mode: Mode = "run",
): Suite => ({
  type: "suite",
  name,
  mode,
  sequential: true,
  children: [],
  beforeAll: [],
  afterAll: [],
  beforeEach: [],
  afterEach: [],
  parent,
});

export const makeFileSuite = (file: string): FileSuite => ({
  ...makeSuite(file, undefined),
  file,
});

/** Full title path from the file root down to (and including) this node. */
export const titlePath = (node: Suite | TestCase): ReadonlyArray<string> => {
  const parts: Array<string> = [];
  let current: Suite | TestCase | undefined = node;
  while (current !== undefined) {
    // Skip the file-root suite name (it's reported separately as `file`).
    if (current.parent !== undefined || current.type === "test") {
      parts.unshift(current.name);
    } else if (current.parent === undefined && current.type === "suite") {
      // file root — stop
    }
    current = current.parent;
  }
  return parts;
};

export const fullTitle = (node: Suite | TestCase): string =>
  titlePath(node).join(" > ");

/** Walk every test in a suite subtree (depth-first, registration order). */
export const forEachTest = (
  suite: Suite,
  f: (test: TestCase) => void,
): void => {
  for (const child of suite.children) {
    if (child.type === "test") f(child);
    else forEachTest(child, f);
  }
};

/** True if the subtree contains a node marked `only`. */
export const containsOnly = (suite: Suite): boolean => {
  if (suite.mode === "only") return true;
  for (const child of suite.children) {
    if (child.type === "test" && child.mode === "only") return true;
    if (child.type === "suite" && containsOnly(child)) return true;
  }
  return false;
};
