import type { NavigationState, PartialState } from "@react-navigation/native";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

const fixture = vi.hoisted(() => ({
  applied: [] as { draftKey: string; text: string }[],
  root: undefined as NavigationState | undefined,
  detailOpens: 0,
}));

vi.mock("../../components/ui/Dialog", () => ({ alert: () => {} }));
vi.mock("./prompt-link-actions", () => ({
  applyLinkedPromptToThreadDraft: async (draftKey: string, prompt: { text: string }) => {
    fixture.applied.push({ draftKey, text: prompt.text });
  },
}));
vi.mock("../../lib/rootNavigation", () => ({
  rootNavigationRef: { getRootState: () => fixture.root },
}));
vi.mock("../../state/atom-registry", async () => {
  const { AtomRegistry } = await import("effect/reactivity");
  return { appAtomRegistry: AtomRegistry.make() };
});
vi.mock("../../state/threads", async () => {
  const { AsyncResult, Atom } = await import("effect/reactivity");
  const Option = await import("effect/Option");
  const shell = Atom.make<object | null>(null);
  const detailSource = Atom.make(AsyncResult.success({ data: Option.none() }));
  // Computing the real detail atom opens the thread's server stream.
  const detail = Atom.make((get) => {
    fixture.detailOpens += 1;
    return get(detailSource);
  });
  return {
    environmentThreadShells: { threadShellAtom: () => shell },
    environmentThreads: { stateAtom: () => detail },
    fixtureShell: shell,
    fixtureDetail: detail,
    fixtureDetailSource: detailSource,
  };
});

const { appAtomRegistry } = await import("../../state/atom-registry");
const { fixtureDetail, fixtureDetailSource, fixtureShell } =
  (await import("../../state/threads")) as unknown as {
    fixtureShell: Atom.Writable<object | null>;
    fixtureDetail: Atom.Atom<unknown>;
    fixtureDetailSource: Atom.Writable<AsyncResult.AsyncResult<{ data: Option.Option<object> }>>;
  };
const { resolvePendingThreadPromptLink, takeThreadPromptLink } = await import("./threadPromptLink");

function setup() {
  fixture.applied.length = 0;
  fixture.root = undefined;
  appAtomRegistry.reset();
  appAtomRegistry.set(fixtureShell, null);
  appAtomRegistry.set(fixtureDetailSource, AsyncResult.success({ data: Option.none() }));
  fixture.detailOpens = 0;
}

const loadedDetail = AsyncResult.success({ data: Option.some({}) });

const threadParams = { environmentId: "env-1", threadId: "thread-1" };

function linkedState(prompt = "Fix the bug"): PartialState<NavigationState> {
  return { routes: [{ name: "Thread", params: { ...threadParams, prompt } }] };
}

function stack(routes: NavigationState["routes"]): NavigationState {
  return {
    key: "root",
    index: routes.length - 1,
    routeNames: routes.map((route) => route.name),
    routes,
    stale: false,
    type: "stack",
  };
}

const threadRoute = stack([{ key: "thread", name: "Thread", params: threadParams }]);

describe("takeThreadPromptLink", () => {
  it("writes no draft for a thread that never shows", () => {
    setup();
    takeThreadPromptLink(linkedState());
    expect(fixture.applied).toEqual([]);

    resolvePendingThreadPromptLink(threadRoute);
    // An unknown thread's screen replaces itself with a new-thread draft.
    resolvePendingThreadPromptLink(
      stack([{ key: "draft", name: "Thread", params: { draft: { draftId: "d" } } }]),
    );
    appAtomRegistry.set(fixtureShell, { id: "thread-1" });
    expect(fixture.applied).toEqual([]);
  });

  it("fills the draft once the linked thread shows on its screen", () => {
    setup();
    takeThreadPromptLink(linkedState());
    fixture.root = threadRoute;
    resolvePendingThreadPromptLink(threadRoute);
    expect(fixture.applied).toEqual([]);

    appAtomRegistry.set(fixtureShell, { id: "thread-1" });
    expect(fixture.applied).toEqual([{ draftKey: expect.any(String), text: "Fix the bug" }]);
    appAtomRegistry.set(fixtureShell, { id: "thread-1", title: "renamed" });
    expect(fixture.applied).toHaveLength(1);
  });

  it("fills the draft of an archived thread its screen shows from detail", () => {
    setup();
    takeThreadPromptLink(linkedState());
    fixture.root = threadRoute;
    // Archived threads have no shell; the open screen subscribes to their detail instead.
    using _screen = { [Symbol.dispose]: appAtomRegistry.mount(fixtureDetail) };
    resolvePendingThreadPromptLink(threadRoute);
    expect(fixture.applied).toEqual([]);

    appAtomRegistry.set(fixtureDetailSource, loadedDetail);
    expect(fixture.applied).toEqual([{ draftKey: expect.any(String), text: "Fix the bug" }]);
  });

  it("opens no detail for a thread no screen has loaded", () => {
    setup();
    takeThreadPromptLink(linkedState());
    fixture.root = threadRoute;
    resolvePendingThreadPromptLink(threadRoute);
    appAtomRegistry.set(fixtureDetailSource, loadedDetail);
    expect(fixture.detailOpens).toBe(0);
    expect(fixture.applied).toEqual([]);
    resolvePendingThreadPromptLink(stack([{ key: "home", name: "Home" }]));
  });

  it("drops an earlier link to the thread when a newer one is invalid", () => {
    setup();
    takeThreadPromptLink(linkedState());
    takeThreadPromptLink(linkedState("\u200b"));
    fixture.root = threadRoute;
    resolvePendingThreadPromptLink(threadRoute);
    appAtomRegistry.set(fixtureShell, { id: "thread-1" });
    expect(fixture.applied).toEqual([]);
  });
});
