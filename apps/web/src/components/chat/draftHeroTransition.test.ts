import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { runMobileComposerTransition } from "./draftHeroTransition";

type StartViewTransition = (update: () => void | Promise<void>) => {
  finished: Promise<void>;
};

function stubEnvironment(input: {
  mobile: boolean;
  reducedMotion?: boolean;
  startViewTransition?: StartViewTransition;
}) {
  const styles = new Map<string, string>();
  const root = {
    style: {
      setProperty: (name: string, value: string) => styles.set(name, value),
      removeProperty: (name: string) => styles.delete(name),
      getPropertyValue: (name: string) => styles.get(name) ?? "",
    },
    dataset: {} as Record<string, string>,
  };
  vi.stubGlobal("window", {
    matchMedia: (query: string) => ({
      matches: query.includes("max-width") ? input.mobile : (input.reducedMotion ?? false),
    }),
  });
  vi.stubGlobal("document", {
    documentElement: root,
    ...(input.startViewTransition ? { startViewTransition: input.startViewTransition } : {}),
  });
  return root;
}

/** A view transition that runs its update after the old snapshot, like the browser does. */
function deferredViewTransition(): StartViewTransition {
  return (update) => ({
    finished: Promise.resolve().then(update),
  });
}

describe("runMobileComposerTransition", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    { name: "desktop viewport", mobile: false, active: true },
    { name: "reduced motion", mobile: true, reducedMotion: true, active: true },
    { name: "panel motion off", mobile: true, active: false },
    { name: "no view transition support", mobile: true, active: true, unsupported: true },
  ])("applies the update before returning on $name", ({ unsupported, active, ...env }) => {
    const startViewTransition = vi.fn(deferredViewTransition());
    stubEnvironment({ ...env, ...(unsupported ? {} : { startViewTransition }) });
    const update = vi.fn();

    const docking = runMobileComposerTransition(update, { active, durationMs: 200 });

    expect(docking).toBeUndefined();
    expect(update).toHaveBeenCalledTimes(1);
    expect(startViewTransition).not.toHaveBeenCalled();
  });

  it("applies the update once inside a mobile view transition and resolves after it", async () => {
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const startViewTransition = vi.fn((update: () => void) => {
      void Promise.resolve().then(update);
      return { finished };
    });
    const root = stubEnvironment({ mobile: true, startViewTransition });
    const update = vi.fn();

    const docking = runMobileComposerTransition(update, { active: true, durationMs: 200 });

    expect(update).not.toHaveBeenCalled();
    expect(root.dataset.mobileComposerRouteTransition).toBe("true");
    expect(root.style.getPropertyValue("--mobile-composer-transition-duration")).toBe("200ms");
    await docking;
    expect(update).toHaveBeenCalledTimes(1);
    expect(root.dataset.mobileComposerRouteTransition).toBe("true");
    finish();
    await finished;
    expect(root.dataset.mobileComposerRouteTransition).toBeUndefined();
    expect(root.style.getPropertyValue("--mobile-composer-transition-duration")).toBe("");
    expect(update).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      name: "the transition cannot start",
      startViewTransition: (): ReturnType<StartViewTransition> => {
        throw new Error("InvalidStateError");
      },
      update: vi.fn(),
    },
    {
      name: "the update throws",
      startViewTransition: deferredViewTransition(),
      update: vi.fn(() => {
        throw new Error("render failed");
      }),
    },
    {
      name: "an inline update throws",
      mobile: false,
      startViewTransition: deferredViewTransition(),
      update: vi.fn(() => {
        throw new Error("render failed");
      }),
    },
  ])(
    "still releases the caller once when $name",
    async ({ mobile = true, startViewTransition, update }) => {
      stubEnvironment({ mobile, startViewTransition });

      await runMobileComposerTransition(update, { active: true, durationMs: 200 });

      expect(update).toHaveBeenCalledTimes(1);
    },
  );
});
