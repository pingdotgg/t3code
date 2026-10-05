import { afterEach, describe, expect, it } from "vite-plus/test";

import { appAtomRegistry } from "./atom-registry";
import {
  clearThreadComposerError,
  clearThreadComposerErrorsForEnvironment,
  setThreadComposerError,
  threadComposerErrorsAtom,
} from "./thread-composer-error";

afterEach(() => {
  appAtomRegistry.set(threadComposerErrorsAtom, {});
});

describe("thread composer errors", () => {
  it("clears a message-scoped error only for that message", () => {
    setThreadComposerError("environment-1:thread-1", "rejected", "message-1");

    clearThreadComposerError("environment-1:thread-1", "message-2");
    expect(appAtomRegistry.get(threadComposerErrorsAtom)["environment-1:thread-1"]?.message).toBe(
      "rejected",
    );

    clearThreadComposerError("environment-1:thread-1");
    expect(appAtomRegistry.get(threadComposerErrorsAtom)).toEqual({});
  });

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
