import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  clearComposerAddonSubmissionPayloadsFrom,
  commitComposerAddonSubmissionPayloadsFrom,
  readComposerAddonSubmissionPayloadsFrom,
} from "./index";
import {
  ComposerAddonSlot,
  composerAddonBlockingIssue,
  type ComposerAddon,
  type ComposerAddonContribution,
} from "./composer";

const THREAD_REF = scopeThreadRef(EnvironmentId.make("environment-1"), ThreadId.make("thread-1"));

function contribution(
  addonId: string,
  contributionId: string,
  blockingIssue: string | null,
): ComposerAddonContribution {
  return { addonId, contributionId, blockingIssue, control: null };
}

function addon(overrides: Partial<ComposerAddon> = {}): ComposerAddon {
  return { useContributions: () => [], ...overrides };
}

describe("composer addon contributions", () => {
  it("returns the first blocking issue in registration order", () => {
    expect(
      composerAddonBlockingIssue([
        contribution("ready", "control", null),
        contribution("blocked", "control", "Complete addon setup"),
        contribution("also-blocked", "control", "Another issue"),
      ]),
    ).toBe("Complete addon setup");
  });

  it("does not block the composer when every addon is ready", () => {
    expect(composerAddonBlockingIssue([contribution("ready", "control", null)])).toBeNull();
  });

  it("keys multiple controls from one addon by stable contribution id", () => {
    const rendered = ComposerAddonSlot({
      contributions: [contribution("fleet", "role", null), contribution("fleet", "boards", null)],
    }) as ReactElement[];

    expect(rendered.map((element) => element.key)).toEqual(["fleet:role", "fleet:boards"]);
  });
});

describe("composer addon lifecycle", () => {
  it("isolates read failures and continues to later addons", () => {
    const result = readComposerAddonSubmissionPayloadsFrom(
      [
        [
          "broken",
          addon({
            readSubmissionPayload: () => {
              throw new Error("broken read");
            },
          }),
        ],
        [
          "ready",
          addon({ readSubmissionPayload: () => ({ revision: "2", payload: { role: "agent" } }) }),
        ],
      ],
      "draft:1",
    );

    expect(result.payloads).toEqual({ ready: { revision: "2", payload: { role: "agent" } } });
    expect(result.failures).toMatchObject([{ addonId: "broken", phase: "read" }]);
  });

  it("isolates commit failures and still commits later addons", async () => {
    const commitReady = vi.fn();
    const clearReady = vi.fn();
    const clearBroken = vi.fn();
    const failures = await commitComposerAddonSubmissionPayloadsFrom(
      [
        [
          "broken",
          addon({
            commitSubmission: () => {
              throw new Error("broken commit");
            },
            clearSubmissionPayload: clearBroken,
          }),
        ],
        ["ready", addon({ commitSubmission: commitReady, clearSubmissionPayload: clearReady })],
      ],
      {
        targetKey: "draft:1",
        threadRef: THREAD_REF,
        payloads: {
          broken: { revision: "1", payload: { role: "broken" } },
          ready: { revision: "2", payload: { role: "ready" } },
        },
      },
    );

    expect(failures).toMatchObject([{ addonId: "broken", phase: "commit" }]);
    expect(clearBroken).not.toHaveBeenCalled();
    expect(commitReady).toHaveBeenCalledWith({
      targetKey: "draft:1",
      threadRef: THREAD_REF,
      revision: "2",
      payload: { role: "ready" },
    });
    expect(clearReady).toHaveBeenCalledWith({
      targetKey: "draft:1",
      expectedRevision: "2",
      reason: "submitted",
    });
  });

  it("passes the snapshotted revision so newer edits are not cleared", async () => {
    let currentRevision = "1";
    const clear = vi.fn(({ expectedRevision }: { expectedRevision: string }) => {
      if (currentRevision === expectedRevision) currentRevision = "cleared";
    });
    const stagedAddon = addon({ commitSubmission: () => undefined, clearSubmissionPayload: clear });
    const snapshot = { revision: currentRevision, payload: { board: "one" } };
    currentRevision = "2";

    await commitComposerAddonSubmissionPayloadsFrom([["fleet", stagedAddon]], {
      targetKey: "draft:1",
      threadRef: THREAD_REF,
      payloads: { fleet: snapshot },
    });

    expect(clear).toHaveBeenCalledWith({
      targetKey: "draft:1",
      expectedRevision: "1",
      reason: "submitted",
    });
    expect(currentRevision).toBe("2");
  });

  it("clears every staged addon on draft discard and isolates failures", async () => {
    const clearReady = vi.fn();
    const failures = await clearComposerAddonSubmissionPayloadsFrom(
      [
        [
          "broken",
          addon({
            readSubmissionPayload: () => ({ revision: "1", payload: {} }),
            clearSubmissionPayload: () => {
              throw new Error("broken clear");
            },
          }),
        ],
        [
          "ready",
          addon({
            readSubmissionPayload: () => ({ revision: "2", payload: {} }),
            clearSubmissionPayload: clearReady,
          }),
        ],
      ],
      "draft:1",
      "discarded",
    );

    expect(failures).toMatchObject([{ addonId: "broken", phase: "clear" }]);
    expect(clearReady).toHaveBeenCalledWith({
      targetKey: "draft:1",
      expectedRevision: "2",
      reason: "discarded",
    });
  });
});
