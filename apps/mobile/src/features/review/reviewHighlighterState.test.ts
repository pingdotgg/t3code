import { assert, beforeEach, it } from "vite-plus/test";
import { AtomRegistry } from "effect/unstable/reactivity";

import {
  createReviewHighlighterManager,
  IDLE_REVIEW_HIGHLIGHTER_STATE,
} from "./reviewHighlighterState";

let registry = AtomRegistry.make();

beforeEach(() => {
  registry.dispose();
  registry = AtomRegistry.make();
});

function flushAsyncWork(): Promise<void> {
  return Promise.resolve().then(() => undefined);
}

it("initializes review highlighter state once", async () => {
  let prepareCalls = 0;
  let languageCalls = 0;
  let engineCalls = 0;
  const manager = createReviewHighlighterManager({
    getRegistry: () => registry,
    loader: {
      prepare: async () => {
        prepareCalls += 1;
      },
      prepareLanguages: async () => {
        languageCalls += 1;
      },
      getEngine: async () => {
        engineCalls += 1;
        return "javascript";
      },
    },
  });

  assert.deepStrictEqual(manager.getSnapshot(), IDLE_REVIEW_HIGHLIGHTER_STATE);

  await Promise.all([manager.initialize(), manager.initialize()]);
  await manager.initialize();

  assert.strictEqual(prepareCalls, 1);
  assert.strictEqual(languageCalls, 1);
  assert.strictEqual(engineCalls, 1);
  assert.deepStrictEqual(manager.getSnapshot(), {
    engine: "javascript",
    error: null,
    status: "ready",
  });
});

it("stores initialization failures in atom state", async () => {
  const cause = new Error("load failed");
  const manager = createReviewHighlighterManager({
    getRegistry: () => registry,
    loader: {
      prepare: async () => {
        throw cause;
      },
      prepareLanguages: async () => undefined,
      getEngine: async () => "javascript",
    },
  });

  void manager.initialize();
  await flushAsyncWork();

  const snapshot = manager.getSnapshot();
  assert.strictEqual(snapshot.engine, null);
  assert.strictEqual(snapshot.status, "error");
  assert.strictEqual(snapshot.error?._tag, "ReviewHighlighterManagerError");
  assert.strictEqual(snapshot.error?.operation, "prepare");
  assert.deepStrictEqual(snapshot.error?.languages, [
    "typescript",
    "tsx",
    "javascript",
    "jsx",
    "json",
    "yaml",
    "bash",
  ]);
  assert.strictEqual(snapshot.error?.cause, cause);
  assert.strictEqual(
    snapshot.error?.message,
    "Review highlighter operation prepare failed for languages typescript, tsx, javascript, jsx, json, yaml, bash.",
  );
});
