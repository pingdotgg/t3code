import { animate } from "motion";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("motion", async (importOriginal) => {
  const original = await importOriginal<typeof import("motion")>();
  return { ...original, animate: vi.fn() };
});

vi.mock("react-dom", () => ({ createPortal: (children: unknown) => children }));

import { ComposerStashFlight, type StashFlightGeometry } from "./ComposerStashFlight";

let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

async function renderFlight(reduced: boolean) {
  const controls: {
    cancel: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    complete: (() => void) | undefined;
  }[] = [];
  const motionAnimate = vi.mocked(animate);
  motionAnimate.mockReset();
  motionAnimate.mockImplementation(() => {
    const control = {
      cancel: vi.fn(),
      stop: vi.fn(),
      complete: undefined as (() => void) | undefined,
      then(callback: () => void) {
        this.complete = callback;
      },
    };
    controls.push(control);
    return control as unknown as ReturnType<typeof animate>;
  });
  const geometryListenerRef = { current: null as ((geometry: StashFlightGeometry) => void) | null };
  const timeline = { currentTime: 100 };
  const onDone = vi.fn();
  const motion = { matches: reduced, addEventListener: vi.fn(), removeEventListener: vi.fn() };
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", {
    matchMedia: () => motion,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  vi.stubGlobal("document", { body: {}, timeline });
  const destination = {
    getBoundingClientRect: () => ({ x: 600, y: 200, width: 80, height: 32 }),
  } as HTMLButtonElement;
  await act(async () => {
    renderer = create(
      <ComposerStashFlight
        flight={{
          key: 1,
          target: "draft",
          text: "Keep this text",
          x: 300,
          y: 300,
          width: 280,
          height: 72,
        }}
        destinationRef={{ current: destination }}
        geometryRef={{ current: { x: 720, y: 400, startTime: 100 } }}
        geometryListenerRef={geometryListenerRef}
        onDone={onDone}
      />,
      { createNodeMock: () => ({ offsetHeight: 72 }) },
    );
  });
  const call = motionAnimate.mock.calls[0];
  const options = call?.[2] as
    | { onComplete?: () => void; duration?: number; startTime?: number }
    | undefined;
  return {
    controls,
    geometryListenerRef,
    timeline,
    animate: motionAnimate,
    onDone,
    motion,
    options,
    complete: () => controls[0]?.complete?.(),
  };
}

describe("saved draft flight", () => {
  it("acknowledges arrival after the animation finishes", async () => {
    const fixture = await renderFlight(false);
    expect(fixture.animate).toHaveBeenCalledTimes(2);
    expect(fixture.onDone).not.toHaveBeenCalled();
    fixture.complete();
    expect(fixture.onDone).toHaveBeenCalledOnce();
  });

  it("lands at the tab's final position on the composer's timeline", async () => {
    const fixture = await renderFlight(false);
    const target = fixture.animate.mock.calls[0]![1];
    expect(target).toMatchObject({ x: [0, 280], y: [0, 64] });
    expect(fixture.animate.mock.calls[1]![2]).toMatchObject({ startTime: 100 });
    expect(fixture.options?.duration).toBe(0.55);
  });

  it("retargets a late editor shrink without extending the arrival deadline", async () => {
    const fixture = await renderFlight(false);
    fixture.timeline.currentTime = 200;
    fixture.geometryListenerRef.current?.({ x: 720, y: 480, startTime: 100 });
    expect(fixture.controls[0]!.stop).toHaveBeenCalledOnce();
    expect(fixture.animate.mock.calls[2]![1]).toMatchObject({ x: 280, y: 144 });
    expect(fixture.animate.mock.calls[2]![2]).toMatchObject({ duration: 0.45 });
    // An interrupted flight cannot acknowledge arrival at the old location.
    fixture.controls[0]!.complete?.();
    expect(fixture.onDone).not.toHaveBeenCalled();
    fixture.controls[2]!.complete?.();
    expect(fixture.onDone).toHaveBeenCalledOnce();
  });

  it.each([650, 700])("settles a retarget at or after the deadline (%s)", async (currentTime) => {
    const fixture = await renderFlight(false);
    fixture.timeline.currentTime = currentTime;
    fixture.geometryListenerRef.current?.({ x: 720, y: 480, startTime: 100 });
    expect(fixture.controls[0]!.stop).toHaveBeenCalledOnce();
    expect(fixture.animate).toHaveBeenCalledTimes(2);
    expect(fixture.onDone).toHaveBeenCalledOnce();
    fixture.geometryListenerRef.current?.({ x: 720, y: 500, startTime: 100 });
    fixture.controls[0]!.complete?.();
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
    expect(fixture.controls.every((control) => control.cancel.mock.calls.length === 1)).toBe(true);
    expect(fixture.geometryListenerRef.current).toBeNull();
    fixture.complete();
    expect(fixture.onDone).not.toHaveBeenCalled();
    expect(fixture.motion.removeEventListener).toHaveBeenCalledOnce();
  });
});
