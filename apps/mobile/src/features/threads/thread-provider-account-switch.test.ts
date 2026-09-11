import { ProviderInstanceId, type ModelSelection } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  resolveComposerModelSelection,
  resolveThreadAccountLock,
  selectThreadProviderGroups,
  type ThreadAccountLock,
} from "./thread-provider-account-switch";

const work = ProviderInstanceId.make("claude_work");
const personal = ProviderInstanceId.make("claude_personal");
const codex = ProviderInstanceId.make("codex");

const providers = [
  { instanceId: work, driver: "claudeAgent", continuation: { groupKey: "claude:work" } },
  { instanceId: personal, driver: "claudeAgent", continuation: { groupKey: "claude:personal" } },
  { instanceId: codex, driver: "codex", continuation: { groupKey: "codex:default" } },
] as unknown as Parameters<typeof selectThreadProviderGroups>[0]["providers"];

const groups = [{ providerKey: work }, { providerKey: personal }, { providerKey: codex }];

function thread(overrides: Partial<ThreadAccountLock> = {}): ThreadAccountLock {
  return {
    modelSelection: { instanceId: work, model: "claude-opus-4-6" },
    session: null,
    latestTurn: null,
    latestUserMessageAt: null,
    ...overrides,
  };
}

describe("resolveThreadAccountLock", () => {
  it("has no lock before the thread runs a turn", () => {
    expect(resolveThreadAccountLock(thread())).toBeUndefined();
  });

  it("keeps the account a stopped session left behind", () => {
    expect(
      resolveThreadAccountLock(thread({ latestUserMessageAt: "2026-06-01T00:00:00.000Z" })),
    ).toBe(work);
  });

  it("prefers the running session over the picked model", () => {
    expect(
      resolveThreadAccountLock(
        thread({ session: { providerInstanceId: personal }, latestTurn: {} }),
      ),
    ).toBe(personal);
  });
});

describe("selectThreadProviderGroups", () => {
  it("offers everything while the thread has no provider conversation", () => {
    expect(
      selectThreadProviderGroups({
        groups,
        lockedInstanceId: undefined,
        providers,
        accountSwitchSupported: true,
      }),
    ).toEqual(groups);
  });

  it("offers the other account of the same provider once the environment supports it", () => {
    expect(
      selectThreadProviderGroups({
        groups,
        lockedInstanceId: work,
        providers,
        accountSwitchSupported: true,
      }).map((group) => group.providerKey),
    ).toEqual([work, personal]);
  });

  it("keeps other accounts out of reach on servers that reject the switch", () => {
    expect(
      selectThreadProviderGroups({
        groups,
        lockedInstanceId: work,
        providers,
        accountSwitchSupported: false,
      }).map((group) => group.providerKey),
    ).toEqual([work]);
  });
});

describe("resolveComposerModelSelection", () => {
  const draftSelection: ModelSelection = { instanceId: personal, model: "claude-opus-4-6" };
  const threadSelection: ModelSelection = { instanceId: work, model: "claude-opus-4-6" };

  it("sends the confirmed account", () => {
    expect(
      resolveComposerModelSelection({
        draftSelection,
        threadSelection,
        threadKey: "env-1:thread-1",
        lockedInstanceId: work,
        confirmedSwitch: { threadKey: "env-1:thread-1", from: work, to: personal, revision: 0 },
      }),
    ).toBe(draftSelection);
  });

  // The draft outlives the send that used it and is written per device, so a
  // stale one must not restart the thread on the account it already left.
  it("falls back to the thread's account when the switch was never confirmed here", () => {
    expect(
      resolveComposerModelSelection({
        draftSelection,
        threadSelection,
        threadKey: "env-1:thread-1",
        lockedInstanceId: work,
        confirmedSwitch: null,
      }),
    ).toBe(threadSelection);
  });

  // Another device already made the switch: the confirmation names an account
  // this thread has left, and the local draft still points back at it.
  it("drops a confirmation the thread has already moved past", () => {
    const movedThreadSelection: ModelSelection = { instanceId: personal, model: "claude-opus-4-6" };
    expect(
      resolveComposerModelSelection({
        draftSelection: threadSelection,
        threadSelection: movedThreadSelection,
        threadKey: "env-1:thread-1",
        lockedInstanceId: personal,
        confirmedSwitch: { threadKey: "env-1:thread-1", from: work, to: personal, revision: 0 },
      }),
    ).toBe(movedThreadSelection);
  });

  it("does not carry a confirmation across threads", () => {
    expect(
      resolveComposerModelSelection({
        draftSelection,
        threadSelection,
        threadKey: "env-1:thread-2",
        lockedInstanceId: work,
        confirmedSwitch: { threadKey: "env-1:thread-1", from: work, to: personal, revision: 0 },
      }),
    ).toBe(threadSelection);
  });

  it.each([draftSelection, undefined])(
    "rejects old consent after returning to the same account (draft: %j)",
    (draftSelection) => {
      expect(
        resolveComposerModelSelection({
          draftSelection,
          threadSelection: { instanceId: personal, model: "claude-opus-4-6" },
          threadKey: "env-1:thread-1",
          lockedInstanceId: work,
          providerAccountRevision: 9,
          confirmedSwitch: { threadKey: "env-1:thread-1", from: work, to: personal, revision: 7 },
        }),
      ).toEqual(threadSelection);
    },
  );

  it("keeps an unlocked thread's draft selection", () => {
    expect(
      resolveComposerModelSelection({
        draftSelection,
        threadSelection,
        threadKey: "env-1:thread-1",
        lockedInstanceId: undefined,
        confirmedSwitch: null,
      }),
    ).toBe(draftSelection);
  });

  it.each([draftSelection, undefined])(
    "returns to the owning account after a failed switch and relaunch (draft: %j)",
    (draftSelection) => {
      expect(
        resolveComposerModelSelection({
          draftSelection,
          threadSelection: { instanceId: personal, model: "claude-opus-4-6" },
          threadKey: "env-1:thread-1",
          lockedInstanceId: work,
          confirmedSwitch: null,
        }),
      ).toEqual(threadSelection);
    },
  );
});
