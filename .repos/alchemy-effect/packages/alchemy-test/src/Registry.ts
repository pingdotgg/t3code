/**
 * Global registration state.
 *
 * The runner imports one test file at a time. While a file's module body is
 * evaluating, `describe`/`test`/hook calls register nodes against the current
 * collector. The registry lives on `globalThis` so that a duplicated module
 * instance (e.g. two resolutions of the package) still shares one registry.
 */
import { makeFileSuite, type FileSuite, type Suite } from "./Model.ts";

interface RegistryState {
  /** Root suite of the file currently being collected. */
  root: FileSuite | undefined;
  /** Suite that `describe`/`test` calls currently attach to. */
  current: Suite | undefined;
}

const key = Symbol.for("alchemy-test/registry");

const state: RegistryState = ((globalThis as any)[key] ??= {
  root: undefined,
  current: undefined,
} satisfies RegistryState);

/** Begin collecting a file. Returns its root suite. */
export const beginFile = (file: string): FileSuite => {
  const root = makeFileSuite(file);
  state.root = root;
  state.current = root;
  return root;
};

/** Finish collecting the current file. */
export const endFile = (): void => {
  state.root = undefined;
  state.current = undefined;
};

export const currentSuite = (): Suite => {
  if (state.current === undefined) {
    throw new Error(
      "alchemy-test: describe/test/hook called outside of a test file collection. " +
        "Run tests with the `alchemy-test` CLI.",
    );
  }
  return state.current;
};

/** Run `f` with `suite` as the current registration target. */
export const withSuite = (suite: Suite, f: () => void): void => {
  const previous = state.current;
  state.current = suite;
  try {
    f();
  } finally {
    state.current = previous;
  }
};
