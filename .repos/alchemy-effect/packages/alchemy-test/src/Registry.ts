/**
 * Per-file registration state.
 *
 * While a test file's module body is evaluating, `describe`/`test`/hook
 * calls register nodes against that file's collector. The runner imports
 * all test files in PARALLEL; attribution stays correct because the
 * collector is carried by AsyncLocalStorage — the module loader propagates
 * the async context of the `import()` call into the module's top-level
 * evaluation (and into microtasks queued from it), so each file's
 * registrations resolve to its own root no matter how many imports are in
 * flight.
 *
 * The storage lives on `globalThis` so that a duplicated module instance
 * (e.g. two resolutions of the package) still shares one registry.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { makeFileSuite, type FileSuite, type Suite } from "./Model.ts";

interface FileContext {
  /** Suite that `describe`/`test` calls currently attach to. */
  current: Suite;
}

const key = Symbol.for("alchemy-test/registry");

const storage: AsyncLocalStorage<FileContext> = ((globalThis as any)[key] ??=
  new AsyncLocalStorage<FileContext>());

/**
 * Collect one file: run `f` (the file's dynamic import + microtask flush)
 * with a fresh root as the ambient collector, and return the root.
 */
export const collect = async (
  file: string,
  f: () => Promise<void>,
): Promise<FileSuite> => {
  const root = makeFileSuite(file);
  await storage.run({ current: root }, f);
  return root;
};

const currentContext = (): FileContext => {
  const context = storage.getStore();
  if (context === undefined) {
    throw new Error(
      "alchemy-test: describe/test/hook called outside of a test file collection. " +
        "Run tests with the `alchemy-test` CLI.",
    );
  }
  return context;
};

export const currentSuite = (): Suite => currentContext().current;

/**
 * The file currently being collected (path relative to the run root, e.g.
 * `test/Cloudflare/R2/Bucket.test.ts`), or `undefined` when called outside
 * of a collection (e.g. from a non-alchemy-test runner). Adapters use this
 * at registration time to namespace per-test durable state by file.
 */
export const currentFile = (): string | undefined => {
  let suite: Suite | undefined = storage.getStore()?.current;
  while (suite?.parent !== undefined) suite = suite.parent;
  return suite !== undefined && "file" in suite
    ? (suite as FileSuite).file
    : undefined;
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
