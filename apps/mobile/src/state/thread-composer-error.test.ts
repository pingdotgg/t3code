import { afterEach, describe, expect, it } from "vite-plus/test";

import { appAtomRegistry } from "./atom-registry";
import {
  clearThreadComposerErrorsForEnvironment,
  setThreadComposerError,
  threadComposerErrorsAtom,
} from "./thread-composer-error";

afterEach(() => {
  appAtomRegistry.set(threadComposerErrorsAtom, {});
});

describe("thread composer errors", () => {
  it("clears every thread's error for a removed environment and no others", () => {
    setThreadComposerError("environment-1:thread-1", "one");
    setThreadComposerError("environment-1:thread-2", "two");
    setThreadComposerError("environment-10:thread-1", "other environment");

    clearThreadComposerErrorsForEnvironment("environment-1");

    expect(Object.keys(appAtomRegistry.get(threadComposerErrorsAtom))).toEqual([
      "environment-10:thread-1",
    ]);
  });
});
