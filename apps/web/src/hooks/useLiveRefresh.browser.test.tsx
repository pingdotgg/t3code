import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { usageRefreshAccountKey } from "@t3tools/client-runtime/state/usage";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, fakeTimers, render } from "../../test/render";
import { LIVE_REFRESH_MIN_INTERVAL_MS, useLiveRefresh } from "./useLiveRefresh";

function Probe(props: {
  readonly refresh: () => void | Promise<unknown>;
  readonly viewKey: string;
  readonly enabled?: boolean;
  readonly intervalMs?: number | null;
  readonly refreshOnShow?: boolean;
  readonly refreshWhileIdle?: boolean;
  readonly refreshKeys?: readonly string[];
  readonly refreshDeadline?: () => number | undefined;
}) {
  useLiveRefresh(props.refresh, {
    key: props.viewKey,
    enabled: props.enabled ?? true,
    ...(props.intervalMs !== undefined ? { intervalMs: props.intervalMs } : {}),
    refreshWhileIdle: props.refreshWhileIdle ?? false,
    ...(props.refreshKeys ? { refreshKeys: props.refreshKeys } : {}),
    ...(props.refreshDeadline ? { refreshDeadline: props.refreshDeadline } : {}),
    ...(props.refreshOnShow !== undefined ? { refreshOnShow: props.refreshOnShow } : {}),
  });
  return null;
}

describe("useLiveRefresh", () => {
  it.each(["sign-in", "reconnect"] as const)("reads fresh quotas after %s", async (transition) => {
    const refresh = vi.fn();
    using _timers = fakeTimers({ now: 9_000_000 });
    const instanceId = ProviderInstanceId.make(`web-auth-change-${transition}`);
    const driver = ProviderDriverKind.make("codex");
    let generation = 0;
    const probe = (auth: ServerProvider["auth"]) => (
      <Probe
        refresh={refresh}
        viewKey="web-auth-change"
        refreshKeys={[
          usageRefreshAccountKey(
            EnvironmentId.make("web-auth-change"),
            [{ instanceId, driver, auth }],
            driver,
            null,
            generation,
          ),
        ]}
        refreshOnShow
        refreshWhileIdle
      />
    );
    // Bare usage hook; nothing here navigates.
    await using screen = await render(
      probe(
        transition === "sign-in"
          ? { status: "unauthenticated" }
          : { status: "authenticated", email: "new@example.com" },
      ),
      { router: false },
    );
    expect(refresh).toHaveBeenCalledTimes(1);
    await screen.rerender(<></>);
    await act(() => vi.advanceTimersByTime(60_000));
    if (transition === "reconnect") generation++;
    await screen.rerender(probe({ status: "authenticated", email: "new@example.com" }));
    expect(refresh).toHaveBeenCalledTimes(2);
    await screen.rerender(<></>);
    await screen.rerender(probe({ status: "authenticated", email: "new@example.com" }));
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it.each(["continuous", "reenabled", "remounted"])(
    "schedules usage intervals after a slow refresh completes (%s)",
    async (lifecycle) => {
      let complete!: () => void;
      const pending = new Promise<void>((resolve) => {
        complete = resolve;
      });
      const refresh = vi.fn().mockReturnValueOnce(pending);
      using _timers = fakeTimers({ now: 3_000_000 });
      const probe = (enabled: boolean) => (
        <Probe
          refresh={refresh}
          viewKey={`slow-usage:${lifecycle}`}
          enabled={enabled}
          refreshOnShow
          refreshWhileIdle
        />
      );
      // A bare hook probe; nothing here navigates.
      await using screen = await render(probe(true), { router: false });
      expect(refresh).toHaveBeenCalledTimes(1);
      await act(() => vi.advanceTimersByTime(1000));
      if (lifecycle !== "continuous") {
        await screen.rerender(lifecycle === "remounted" ? <></> : probe(false));
      }
      await act(() => vi.advanceTimersByTime(1000));
      if (lifecycle !== "continuous") await screen.rerender(probe(true));
      await act(() => vi.advanceTimersByTime(28_000));
      await act(() => complete());
      await act(() => vi.advanceTimersByTime(299_000));
      expect(refresh).toHaveBeenCalledTimes(1);
      await act(() => vi.advanceTimersByTime(1000));
      expect(refresh).toHaveBeenCalledTimes(2);
    },
  );

  it.each(["reenabled", "remounted", "another entry point", "another client"])(
    "keeps the completed usage deadline when %s",
    async (lifecycle) => {
      let sampledAt = 4_000_000;
      const refresh = vi.fn(() => {
        if (lifecycle === "another client" && Date.now() - sampledAt >= 300_000)
          sampledAt = Date.now();
      });
      let otherEntry = false;
      using _timers = fakeTimers({ now: 4_000_000 });
      const probe = (enabled: boolean) => (
        <Probe
          refresh={refresh}
          viewKey={`completed-usage:${lifecycle}:${otherEntry}`}
          {...(lifecycle === "another entry point" ? { refreshKeys: ["completed-provider"] } : {})}
          {...(lifecycle === "another client"
            ? { refreshDeadline: () => sampledAt + 300_000 }
            : {})}
          enabled={enabled}
          refreshOnShow
          refreshWhileIdle
        />
      );
      // A bare hook probe; nothing here navigates.
      await using screen = await render(probe(true), { router: false });
      expect(refresh).toHaveBeenCalledTimes(1);
      await screen.rerender(lifecycle !== "reenabled" ? <></> : probe(false));
      await act(() => vi.advanceTimersByTime(4 * 60_000));
      otherEntry = lifecycle === "another entry point" || lifecycle === "another client";
      await screen.rerender(probe(true));
      expect(refresh).toHaveBeenCalledTimes(lifecycle === "another client" ? 2 : 1);
      await act(() => vi.advanceTimersByTime(60_000));
      expect(refresh).toHaveBeenCalledTimes(lifecycle === "another client" ? 3 : 2);
      await act(() => vi.advanceTimersByTime(5 * 60_000));
      expect(refresh).toHaveBeenCalledTimes(lifecycle === "another client" ? 4 : 3);
    },
  );

  it.each(["advances", "remains overdue", "remounted overdue"] as const)(
    "rechecks an overdue server deadline after a wider read, then paces retries (%s)",
    async (lifecycle) => {
      let complete!: () => void;
      const refresh = vi.fn().mockReturnValueOnce(
        new Promise<void>((resolve) => {
          complete = resolve;
        }),
      );
      const probe = () => (
        <Probe
          refresh={refresh}
          viewKey={`overdue-server:${lifecycle}`}
          refreshOnShow
          refreshWhileIdle
          refreshDeadline={() =>
            refresh.mock.calls.length === 1 || lifecycle !== "advances" ? 300_000 : 610_000
          }
        />
      );
      // This probe only observes the scheduler.
      await using screen = await render(probe(), { router: false });
      using _timers = fakeTimers({ now: 310_000 });
      await act(() => complete());
      await act(() => vi.advanceTimersByTime(0));
      expect(refresh).toHaveBeenCalledTimes(2);
      if (lifecycle === "remounted overdue") {
        await screen.rerender(<></>);
        await screen.rerender(probe());
      }
      await act(() => {
        window.dispatchEvent(new Event("focus"));
        window.dispatchEvent(new Event("focus"));
        vi.advanceTimersByTime(LIVE_REFRESH_MIN_INTERVAL_MS - 1);
      });
      expect(refresh).toHaveBeenCalledTimes(2);
      await act(() => vi.advanceTimersByTime(1));
      expect(refresh).toHaveBeenCalledTimes(lifecycle === "advances" ? 2 : 3);
      await act(() => vi.advanceTimersByTime(LIVE_REFRESH_MIN_INTERVAL_MS));
      expect(refresh).toHaveBeenCalledTimes(lifecycle === "advances" ? 2 : 4);
    },
  );

  it("rechecks the shared deadline between simultaneous usage consumers", async () => {
    const reads: Array<{ promise: Promise<void>; resolve: () => void }> = [];
    const refresh = vi.fn(() => {
      let resolve!: () => void;
      const promise = new Promise<void>((done) => {
        resolve = done;
      });
      const read = { promise, resolve };
      reads.push(read);
      return read.promise;
    });
    using _timers = fakeTimers({ now: 5_000_000 });
    // Bare hook probes share one usage surface key; nothing here navigates.
    await using _screen = await render(
      <>
        <Probe
          refresh={refresh}
          viewKey="shared-composer"
          refreshKeys={["shared-provider"]}
          refreshOnShow
          refreshWhileIdle
        />
        <Probe
          refresh={refresh}
          viewKey="shared-limits"
          refreshKeys={["shared-provider"]}
          refreshOnShow
          refreshWhileIdle
        />
      </>,
      { router: false },
    );
    expect(refresh).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTime(1000));
    await act(() => reads[0]!.resolve());
    await act(() => vi.advanceTimersByTime(300_000));
    expect(refresh).toHaveBeenCalledTimes(2);
    await act(() => vi.advanceTimersByTime(1000));
    await act(() => reads[1]!.resolve());
    await act(() => vi.advanceTimersByTime(299_000));
    expect(refresh).toHaveBeenCalledTimes(2);
    await act(() => vi.advanceTimersByTime(1000));
    expect(refresh).toHaveBeenCalledTimes(3);
    await act(() => reads[2]!.resolve());
  });

  it("refreshes a newly visible provider without postponing another provider's deadline", async () => {
    const refresh = vi.fn();
    using _timers = fakeTimers({ now: 6_000_000 });
    const probe = (keys: string[]) => (
      <Probe
        refresh={refresh}
        viewKey={keys.join(":")}
        refreshKeys={keys}
        refreshOnShow
        refreshWhileIdle
      />
    );
    // Bare hook probes; no navigation occurs.
    await using screen = await render(probe(["provider-a"]), { router: false });
    expect(refresh).toHaveBeenCalledTimes(1);
    await screen.rerender(<></>);
    await act(() => vi.advanceTimersByTime(240_000));
    await screen.rerender(probe(["provider-a", "provider-b"]));
    expect(refresh).toHaveBeenCalledTimes(2);
    await act(() => vi.advanceTimersByTime(60_000));
    expect(refresh).toHaveBeenCalledTimes(3);
    await act(() => vi.advanceTimersByTime(240_000));
    expect(refresh).toHaveBeenCalledTimes(4);
  });

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
    const shared = vi.fn();
    // The interaction clock starts when the first view mounts.
    using _timers = fakeTimers({ now: 1_000_000 });
    await using _screen = await render(
      <>
        <Probe refresh={periodic} viewKey="periodic" intervalMs={60_000} />
        <Probe refresh={untimed} viewKey="untimed" intervalMs={null} />
        <Probe
          refresh={shared}
          viewKey="shared-default"
          refreshKeys={["default-provider"]}
          refreshWhileIdle
        />
      </>,
      // A bare hook probe; nothing here navigates.
      { router: false },
    );

    expect(shared).not.toHaveBeenCalled();

    // Past the default 5 minute interval, but inside the 6 minute idle cutoff.
    await act(() => vi.advanceTimersByTime(5.5 * 60_000));

    expect(periodic).toHaveBeenCalledTimes(5);
    expect(untimed).not.toHaveBeenCalled();
    expect(shared).toHaveBeenCalledTimes(1);
  });
});
