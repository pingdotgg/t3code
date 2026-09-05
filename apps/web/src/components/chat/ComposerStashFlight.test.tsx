import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("react-dom", () => ({ createPortal: (children: unknown) => children }));

import { ComposerStashFlight } from "./ComposerStashFlight";

let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

async function renderFlight(reduced: boolean) {
  const animation = { cancel: vi.fn(), onfinish: null as (() => void) | null };
  const animate = vi.fn(() => animation);
  const onDone = vi.fn();
  const motion = { matches: reduced, addEventListener: vi.fn(), removeEventListener: vi.fn() };
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", {
    matchMedia: () => motion,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  vi.stubGlobal("document", { body: {} });
  const destination = {
    getBoundingClientRect: () => ({ x: 600, y: 200, width: 80, height: 32 }),
  } as HTMLButtonElement;
  await act(async () => {
    renderer = create(
      <ComposerStashFlight
        flight={{ key: 1, target: "draft", text: "Keep this text", x: 300, y: 300, width: 280 }}
        destinationRef={{ current: destination }}
        onDone={onDone}
      />,
      { createNodeMock: () => ({ animate, offsetHeight: 72 }) },
    );
  });
  return { animation, animate, onDone, motion };
}

describe("saved draft flight", () => {
  it("acknowledges arrival after the animation finishes", async () => {
    const fixture = await renderFlight(false);
    expect(fixture.animate).toHaveBeenCalledOnce();
    expect(fixture.onDone).not.toHaveBeenCalled();
    fixture.animation.onfinish?.();
    expect(fixture.onDone).toHaveBeenCalledOnce();
  });

  it("acknowledges without moving the draft when reduced motion is requested", async () => {
    const fixture = await renderFlight(true);
    expect(fixture.animate).not.toHaveBeenCalled();
    expect(fixture.onDone).toHaveBeenCalledOnce();
  });

  it("cancels an unfinished flight on unmount without reporting a late arrival", async () => {
    const fixture = await renderFlight(false);
    await act(async () => renderer?.unmount());
    renderer = undefined;
    expect(fixture.animation.cancel).toHaveBeenCalledOnce();
    expect(fixture.animation.onfinish).toBeNull();
    expect(fixture.onDone).not.toHaveBeenCalled();
    expect(fixture.motion.removeEventListener).toHaveBeenCalledOnce();
  });
});
