import { threadKey } from "@t3tools/client-runtime/state/entities";
import { EMPTY_ENVIRONMENT_THREAD_STATE } from "@t3tools/client-runtime/state/threads";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { createThreadViews, type ShownViewHints, type ThreadViewConfig } from "./threadView";

const ref = { environmentId: EnvironmentId.make("environment-1"), threadId: ThreadId.make("t-1") };

const configWith = (mode: string | null, capable = true): ThreadViewConfig => ({
  environment: { capabilities: capable ? { threadShownHistory: true } : {} },
  settings: { threadDisplayModes: mode === null ? {} : { [ref.threadId]: mode } },
});

/** A seam over a base whose states record each view they open, as a subscription would. */
function setup(hinted: boolean) {
  const config = Atom.make<ThreadViewConfig | null>(null);
  const keys = new Set(hinted ? [threadKey(ref)] : []);
  const hints: ShownViewHints = {
    has: (key) => keys.has(key),
    set: (key, shown) => void (shown ? keys.add(key) : keys.delete(key)),
  };
  const opened: boolean[] = [];
  const baseFamily = Atom.family((shownOnly: boolean) =>
    Atom.make(() => {
      opened.push(shownOnly);
      return AsyncResult.success(EMPTY_ENVIRONMENT_THREAD_STATE);
    }).pipe(Atom.setIdleTTL(0)),
  );
  const views = createThreadViews(() => config, hints);
  const states = views.wrap({ stateAtom: (_e, _t, shownOnly = false) => baseFamily(shownOnly) });
  const tasks: Array<() => void> = [];
  const registry = AtomRegistry.make({
    scheduleTask: (task) => {
      tasks.push(task);
      return () => {};
    },
  });
  const unmount = registry.mount(states.stateAtom(ref.environmentId, ref.threadId));
  const setConfig = (value: ThreadViewConfig) => {
    registry.set(config, value);
    for (let task = tasks.shift(); task !== undefined; task = tasks.shift()) task();
  };
  return { setConfig, keys, opened, unmount };
}

describe("display-mode thread views", () => {
  it("opens only the shown view on a cold start of a thread last seen in a display mode", () => {
    const h = setup(true);
    h.setConfig(configWith("chat-replies"));
    expect(h.opened).toEqual([true]);
    h.unmount();
  });

  it("opens only the Normal view of a thread with no hint, and keeps Normal on an old server", () => {
    const h = setup(false);
    h.setConfig(configWith("chat-replies", false));
    expect(h.opened).toEqual([false]);
    expect(h.keys.size).toBe(0);
    h.unmount();
  });

  it("switches views when the mode changes, and remembers the answer", () => {
    const h = setup(false);
    h.setConfig(configWith("chat-replies"));
    expect(h.keys.has(threadKey(ref))).toBe(true);
    h.setConfig(configWith(null));
    expect(h.opened).toEqual([false, true, false]);
    expect(h.keys.size).toBe(0);
    h.unmount();
  });
});
