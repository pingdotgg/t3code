import { afterEach, describe, expect, it } from "vite-plus/test";
import type { ThreadId } from "@t3tools/contracts";

import { resolveFocusedSideChat, useSideChatFocusStore } from "./sideChatStore";

const parentKey = "env:parent";
const first = "first" as ThreadId;
const second = "second" as ThreadId;

const focused = () => useSideChatFocusStore.getState().byParent[parentKey];
const aside = (threadId: string) => ({
  id: `aside:${threadId}` as const,
  kind: "aside" as const,
  threadId,
});

afterEach(() => {
  useSideChatFocusStore.setState({ byParent: {} });
});

describe("side chat focus", () => {
  it("releases only the side chat that still has the composer", () => {
    const { focus, release } = useSideChatFocusStore.getState();
    focus(parentKey, first);
    focus(parentKey, second);

    release(parentKey, first);
    expect(focused()).toBe(second);

    release(parentKey);
    expect(focused()).toBeUndefined();
  });

  it("counts only while the side chat's tab is the open panel's active one", () => {
    const resolve = (input: Partial<Parameters<typeof resolveFocusedSideChat>[0]>) =>
      resolveFocusedSideChat({
        picked: first,
        panelOpen: true,
        activeSurface: aside(first),
        ...input,
      });

    expect(resolve({})).toBe(first);
    expect(resolve({ panelOpen: false })).toBeNull();
    expect(resolve({ activeSurface: aside(second) })).toBeNull();
    expect(resolve({ activeSurface: { id: "diff", kind: "diff" } })).toBeNull();
    expect(resolve({ activeSurface: null })).toBeNull();
    expect(resolve({ picked: null })).toBeNull();
  });
});
