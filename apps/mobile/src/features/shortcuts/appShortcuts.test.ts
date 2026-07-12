import { describe, expect, it } from "vite-plus/test";
import type { NavigationState } from "@react-navigation/native";

import type { RecentThreadShortcut } from "../../persistence/imperative";
import {
  activeThreadRef,
  buildShortcutActions,
  MAX_RECENT_THREAD_SHORTCUTS,
  NEW_TASK_SHORTCUT_ID,
  shortcutHref,
  withRecentThreadShortcut,
} from "./appShortcuts";

function navState(route: { name: string; params?: unknown }): NavigationState {
  return { index: 0, routes: [route] } as unknown as NavigationState;
}

function thread(suffix: string, title = `Thread ${suffix}`): RecentThreadShortcut {
  return { environmentId: `env-${suffix}`, threadId: `thread-${suffix}`, title };
}

describe("withRecentThreadShortcut", () => {
  it("prepends a newly opened thread", () => {
    const next = withRecentThreadShortcut([thread("a")], thread("b"));
    expect(next.map((entry) => entry.threadId)).toEqual(["thread-b", "thread-a"]);
  });

  it("moves a reopened thread to the front without duplicating it", () => {
    const next = withRecentThreadShortcut([thread("a"), thread("b")], thread("b"));
    expect(next.map((entry) => entry.threadId)).toEqual(["thread-b", "thread-a"]);
  });

  it("caps the list at the shortcut budget", () => {
    const current = [thread("a"), thread("b"), thread("c")];
    const next = withRecentThreadShortcut(current, thread("d"));
    expect(next).toHaveLength(MAX_RECENT_THREAD_SHORTCUTS);
    expect(next[0]?.threadId).toBe("thread-d");
    expect(next.map((entry) => entry.threadId)).not.toContain("thread-c");
  });

  it("returns the same array when the thread already leads with the same title", () => {
    const current = [thread("a"), thread("b")];
    expect(withRecentThreadShortcut(current, thread("a"))).toBe(current);
  });

  it("keeps the known title when a reopen records an empty one", () => {
    const current = [thread("a", "Fix the build")];
    const next = withRecentThreadShortcut(current, thread("a", ""));
    expect(next).toBe(current);
  });

  it("updates the title once the shell provides one", () => {
    const current = [thread("a", "")];
    const next = withRecentThreadShortcut(current, thread("a", "Fix the build"));
    expect(next[0]?.title).toBe("Fix the build");
    expect(next).toHaveLength(1);
  });
});

describe("buildShortcutActions", () => {
  it("leads with the static new-task action", () => {
    const actions = buildShortcutActions([thread("a")]);
    expect(actions[0]?.id).toBe(NEW_TASK_SHORTCUT_ID);
    expect(actions[0]?.params?.href).toBe("/new");
    expect(actions).toHaveLength(2);
  });

  it("deep-links threads with encoded route params", () => {
    const actions = buildShortcutActions([
      { environmentId: "env 1", threadId: "thread/2", title: "Spaced out" },
    ]);
    expect(actions[1]?.params?.href).toBe("/threads/env%201/thread%2F2");
    expect(actions[1]?.title).toBe("Spaced out");
  });

  it("falls back to a generic label for missing titles", () => {
    const actions = buildShortcutActions([thread("a", "  ")]);
    expect(actions[1]?.title).toBe("Thread");
  });
});

describe("shortcutHref", () => {
  it("accepts exactly the destinations shortcuts can produce", () => {
    expect(shortcutHref({ id: "x", title: "x", params: { href: "/new" } })).toBe("/new");
    expect(shortcutHref({ id: "x", title: "x", params: { href: "/threads/env-1/thread-2" } })).toBe(
      "/threads/env-1/thread-2",
    );
    expect(
      shortcutHref({ id: "x", title: "x", params: { href: "/threads/env%201/thread%2F2" } }),
    ).toBe("/threads/env%201/thread%2F2");
  });

  it("rejects everything else", () => {
    for (const href of [
      "https://evil.example",
      "//evil.example",
      "/settings",
      "/threads/only-one-segment",
      "/threads/a/b/c",
      "/threads//x",
      "/threads/a/b?x=1",
      "/threads/a/b#frag",
      "/new/extra",
    ]) {
      expect(shortcutHref({ id: "x", title: "x", params: { href } })).toBe(null);
    }
    expect(shortcutHref({ id: "x", title: "x", params: { href: 3 } })).toBe(null);
    expect(shortcutHref({ id: "x", title: "x" })).toBe(null);
  });
});

describe("activeThreadRef", () => {
  it("resolves the active Thread route's params", () => {
    const ref = activeThreadRef(
      navState({ name: "Thread", params: { environmentId: "env-1", threadId: "thread-2" } }),
    );
    expect(ref).toEqual({ environmentId: "env-1", threadId: "thread-2" });
  });

  it("takes the first value of array params", () => {
    const ref = activeThreadRef(
      navState({ name: "Thread", params: { environmentId: ["env-1"], threadId: ["thread-2"] } }),
    );
    expect(ref).toEqual({ environmentId: "env-1", threadId: "thread-2" });
  });

  it("returns null for non-thread routes", () => {
    expect(activeThreadRef(navState({ name: "Home" }))).toBe(null);
  });

  it("returns null instead of throwing for malformed params", () => {
    const malformed: unknown[] = [
      undefined,
      {},
      { environmentId: "env-1" },
      { environmentId: "", threadId: "thread-2" },
      { environmentId: "   ", threadId: "thread-2" },
      { environmentId: "env-1", threadId: "  " },
      { environmentId: 42, threadId: "thread-2" },
      { environmentId: { nested: true }, threadId: "thread-2" },
      { environmentId: [], threadId: [] },
    ];
    for (const params of malformed) {
      expect(activeThreadRef(navState({ name: "Thread", params }))).toBe(null);
    }
  });
});

describe("launcher shortcut ids", () => {
  it("cannot collide across different env/thread pairs", () => {
    const a = buildShortcutActions([{ environmentId: "a-b", threadId: "c", title: "x" }]);
    const b = buildShortcutActions([{ environmentId: "a", threadId: "b-c", title: "x" }]);
    expect(a[1]?.id).not.toBe(b[1]?.id);
  });
});
