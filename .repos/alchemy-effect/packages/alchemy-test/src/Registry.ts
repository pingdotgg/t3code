/**
 * Per-file registration state.
 *
 * While a test file's module body is evaluating, `describe`/`test`/hook
 * calls register nodes against that file's collector. The runner may call
 * `collect` for many files at once, but collections run one at a time: each
 * waits its turn on a process-wide queue, sets the collector in a plain slot,
 * imports the file and flushes the microtasks it queued, then clears the slot.
 * Attribution therefore never depends on the runtime carrying async context
 * through `import()` (Bun 1.4 does not), including registrations deferred with
 * `queueMicrotask` and module bodies that use top-level `await`.
 *
 * The state lives on `globalThis` so that a duplicated module instance
 * (e.g. two resolutions of the package) still shares one registry.
 */
import { makeFileSuite, type FileSuite, type Suite } from "./Model.ts";

interface FileContext {
  /** Suite that `describe`/`test` calls currently attach to. */
  current: Suite;
}

interface RegistryState {
  /** The collector of the file being collected, if any. */
  active: FileContext | undefined;
  /** The tail of the collection queue. */
  tail: Promise<unknown>;
}

const key = Symbol.for("alchemy-test/registry@2");

const state: RegistryState = ((globalThis as any)[key] ??= {
  active: undefined,
  tail: Promise.resolve(),
} satisfies RegistryState);

/**
 * Collect one file: once every earlier collection has finished, run `f` (the
 * file's dynamic import + microtask flush) with `root` (a fresh one by
 * default) as the active collector, and return it.
 */
export const collect = (
  file: string,
  f: () => Promise<void>,
  root: FileSuite = makeFileSuite(file),
): Promise<FileSuite> => {
  const run = state.tail.then(async () => {
    state.active = { current: root };
    try {
      await f();
    } finally {
      state.active = undefined;
    }
    return root;
  });
  state.tail = run.catch(() => undefined);
  return run;
};

const currentContext = (): FileContext => {
  const context = state.active;
  if (context === undefined) {
    throw new Error(
      "alchemy-test: describe/test/hook called outside of a test file collection. " +
        "Run tests with the `alchemy-test` CLI.",
    );
  }
  return context;
};

export const currentSuite = (): Suite => currentContext().current;

export const currentFileSuite = (): FileSuite => {
  let suite = currentSuite();
  while (suite.parent !== undefined) suite = suite.parent;
  return suite as FileSuite;
};

/**
 * The file currently being collected (path relative to the run root, e.g.
 * `test/Cloudflare/R2/Bucket.test.ts`), or `undefined` when called outside
 * of a collection (e.g. from a non-alchemy-test runner). Adapters use this
 * at registration time to namespace per-test durable state by file.
 */
export const currentFile = (): string | undefined => {
  let suite: Suite | undefined = state.active?.current;
  while (suite?.parent !== undefined) suite = suite.parent;
  return suite !== undefined && "file" in suite ? (suite as FileSuite).file : undefined;
};

/** Run `f` with `suite` as the current registration target. */
export const withSuite = (suite: Suite, f: () => void): void => {
  const context = currentContext();
  const previous = context.current;
  context.current = suite;
  try {
    f();
  } finally {
    context.current = previous;
  }
};
