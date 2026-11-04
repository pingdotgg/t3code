import { describe, expect, it, vi } from "vite-plus/test";

import { act, fakeTimers, render } from "../../test/render";
import { LIVE_REFRESH_MIN_INTERVAL_MS, useLiveRefresh } from "./useLiveRefresh";

function Probe(props: {
  readonly refresh: () => void;
  readonly viewKey: string;
  readonly enabled?: boolean;
  readonly intervalMs?: number | null;
  readonly refreshOnShow?: boolean;
}) {
  useLiveRefresh(props.refresh, {
    key: props.viewKey,
    enabled: props.enabled ?? true,
    ...(props.intervalMs !== undefined ? { intervalMs: props.intervalMs } : {}),
    ...(props.refreshOnShow !== undefined ? { refreshOnShow: props.refreshOnShow } : {}),
  });
  return null;
}

describe("useLiveRefresh", () => {
  it.each([true, false])(
    "refreshes a hidden mount on arrival with refreshOnShow=%s",
    async (refreshOnShow) => {
      const refresh = vi.fn();
      let visibility: DocumentVisibilityState = "hidden";
      using _visibility = vi
        .spyOn(document, "visibilityState", "get")
        .mockImplementation(() => visibility);
      using _timers = fakeTimers({ now: 2_000_000 });
      // A bare hook probe; nothing here navigates.
      await using _screen = await render(
        <Probe
          refresh={refresh}
          viewKey={`hidden-usage:${refreshOnShow}`}
          refreshOnShow={refreshOnShow}
        />,
        { router: false },
      );
      expect(refresh).not.toHaveBeenCalled();
      await act(() => vi.advanceTimersByTime(30_000));
      visibility = "visible";
      await act(() => document.dispatchEvent(new Event("visibilitychange")));
      expect(refresh).toHaveBeenCalledTimes(1);
    },
  );

  it("with refreshOnShow, reads on every show unless it read within the floor", async () => {
    const refresh = vi.fn();
    // The first enable reads the clock.
    using _timers = fakeTimers({ now: 1_000_000 });
    const probe = (enabled: boolean) => (
      <Probe refresh={refresh} viewKey="show" enabled={enabled} refreshOnShow intervalMs={null} />
    );
    // A bare hook probe; nothing here navigates.
    await using screen = await render(probe(true), { router: false });
    expect(refresh).toHaveBeenCalledTimes(1);

    await screen.rerender(probe(false));
    await act(() => vi.advanceTimersByTime(LIVE_REFRESH_MIN_INTERVAL_MS - 1));
    await screen.rerender(probe(true));
    expect(refresh).toHaveBeenCalledTimes(1);

    await screen.rerender(probe(false));
    await act(() => vi.advanceTimersByTime(1));
    await screen.rerender(probe(true));
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("with intervalMs null, never refreshes on a timer", async () => {
    const periodic = vi.fn();
    const untimed = vi.fn();
    // The interaction clock starts when the first view mounts.
    using _timers = fakeTimers({ now: 1_000_000 });
    await using _screen = await render(
      <>
        <Probe refresh={periodic} viewKey="periodic" intervalMs={60_000} />
        <Probe refresh={untimed} viewKey="untimed" intervalMs={null} />
      </>,
      // A bare hook probe; nothing here navigates.
      { router: false },
    );

    // Past the default 5 minute interval, but inside the 6 minute idle cutoff.
    await act(() => vi.advanceTimersByTime(5.5 * 60_000));

    expect(periodic).toHaveBeenCalledTimes(5);
    expect(untimed).not.toHaveBeenCalled();
  });
});
