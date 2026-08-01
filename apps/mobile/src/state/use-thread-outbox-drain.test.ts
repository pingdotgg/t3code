import { AtomRegistry } from "effect/unstable/reactivity";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("../lib/uuid", () => ({
  randomHex: vi.fn(() => "00"),
  uuidv4: vi.fn(() => "00000000-0000-4000-8000-000000000000"),
}));

vi.mock("./presentation", async () => {
  const { Atom } = await import("effect/unstable/reactivity");
  return { environmentPresentations: { presentationsAtom: Atom.make(new Map()) } };
});

vi.mock("./projects", async () => {
  const { Atom } = await import("effect/unstable/reactivity");
  return { environmentProjects: { projectsAtom: Atom.make([]) } };
});

vi.mock("./threads", async () => {
  const { Atom } = await import("effect/unstable/reactivity");
  return {
    environmentThreadShells: { threadShellsAtom: Atom.make([]) },
    threadEnvironment: {
      setInteractionMode: {},
      setRuntimeMode: {},
      startTurn: {},
      updateMetadata: {},
    },
  };
});

vi.mock("./use-thread-outbox", async () => {
  const { Atom } = await import("effect/unstable/reactivity");
  return {
    editingQueuedMessageIdsAtom: Atom.make({}),
    threadOutboxShellStatusesAtom: Atom.make(new Map()),
  };
});

vi.mock("./thread-outbox", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./thread-outbox")>();
  return {
    ...actual,
    ensureThreadOutboxLoaded: vi.fn(),
  };
});

import { ensureThreadOutboxLoaded } from "./thread-outbox";
import { acquireThreadOutboxDrain } from "./use-thread-outbox-drain";

describe("thread outbox drain ownership", () => {
  beforeEach(() => {
    vi.mocked(ensureThreadOutboxLoaded).mockClear();
  });

  it("shares one dispatcher until the final owner releases", async () => {
    const registry = AtomRegistry.make();
    const subscribe = vi.spyOn(registry, "subscribe");

    const releaseUi = acquireThreadOutboxDrain(registry);
    const subscriptionsPerDispatcher = subscribe.mock.calls.length;
    expect(subscriptionsPerDispatcher).toBeGreaterThan(0);
    expect(ensureThreadOutboxLoaded).toHaveBeenCalledTimes(1);

    const releaseBackground = acquireThreadOutboxDrain(registry);
    expect(subscribe).toHaveBeenCalledTimes(subscriptionsPerDispatcher);
    expect(ensureThreadOutboxLoaded).toHaveBeenCalledTimes(1);

    releaseUi();
    releaseUi();
    const releaseReplacementUi = acquireThreadOutboxDrain(registry);
    expect(subscribe).toHaveBeenCalledTimes(subscriptionsPerDispatcher);
    expect(ensureThreadOutboxLoaded).toHaveBeenCalledTimes(1);

    releaseBackground();
    expect(ensureThreadOutboxLoaded).toHaveBeenCalledTimes(1);
    releaseReplacementUi();

    const releaseNextOwner = acquireThreadOutboxDrain(registry);
    expect(subscribe).toHaveBeenCalledTimes(subscriptionsPerDispatcher * 2);
    expect(ensureThreadOutboxLoaded).toHaveBeenCalledTimes(2);
    releaseNextOwner();

    await Promise.resolve();
    registry.dispose();
  });
});
