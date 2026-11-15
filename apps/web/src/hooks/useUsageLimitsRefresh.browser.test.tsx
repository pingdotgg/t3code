import { AsyncResult } from "effect/reactivity";
import { EnvironmentId, ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { act, fakeTimers, render } from "../../test/render";
import { BackgroundThreadContext } from "../components/chat/backgroundThread";
import { useUsageLimitsPanel } from "../components/chat/useUsageLimitsPanel";

vi.mock("../components/chat/ComposerUsageLimits", () => ({ usageLimitsBannerItem: mocks.banner }));
vi.mock("../components/ui/toast", () => ({ toastManager: { add: vi.fn() } }));

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  banner: vi.fn<(id: string, report: { createdAt: string }) => { id: string }>(),
}));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => mocks.refresh }));
vi.mock("../state/server", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    environmentServerConfigsAtom: Atom.make(new Map()),
    serverEnvironment: {
      refreshProviders: {},
      configValueAtom: () => Atom.make({ usageLimitSources: [] }),
    },
  };
});
vi.mock("../state/presentation", async () => {
  const { Atom } = await import("effect/reactivity");
  const presentation = Atom.make({ connection: { phase: "connected" } });
  return { environmentPresentations: { presentationAtom: () => presentation } };
});

function setup() {
  mocks.refresh.mockReset().mockResolvedValue(AsyncResult.success({ providers: [] }));
  mocks.banner.mockReset().mockImplementation((id) => ({ id }));
  return mocks;
}

function Probe({ visible }: { readonly visible: boolean }) {
  const instanceId = ProviderInstanceId.make("cursor-retained");
  const driver = ProviderDriverKind.make("cursor");
  const panel = useUsageLimitsPanel({
    environmentId: EnvironmentId.make("retained-usage"),
    threadKey: "thread-one",
    panelKey: "report-one",
    providerInstanceId: instanceId,
    providerDriver: driver,
    visible,
    providers: [
      {
        instanceId,
        driver,
        enabled: true,
        installed: true,
        version: null,
        status: "ready",
        auth: { status: "authenticated" },
        checkedAt: "2026-04-10T00:00:01.000Z",
        models: [],
        slashCommands: [],
        skills: [],
        usageLimits: {
          checkedAt: "2026-04-10T00:00:01.000Z",
          windows: [{ id: "primary", kind: "session", label: "Session", usedPercent: 70 }],
        },
      },
    ],
    sources: [],
  });
  return (
    <button type="button" onClick={panel.open}>
      Open usage report
    </button>
  );
}

it("pauses a retained report when its column is hidden or covered, then refreshes on return", async () => {
  const { refresh, banner } = setup();
  using _timers = fakeTimers({ now: 4_000_000 });
  const probe = (visible: boolean) => (
    <BackgroundThreadContext value>
      <Probe visible={visible} />
    </BackgroundThreadContext>
  );
  await using screen = await render(probe(true), { router: "/environment-one/thread-one" });
  expect(refresh).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Open usage report" }));
  expect(refresh).toHaveBeenCalledTimes(1);
  const initialBannerId = banner.mock.lastCall?.[0];
  const initialReportTime = banner.mock.lastCall?.[1].createdAt;
  await act(() => vi.advanceTimersByTime(60_000));
  expect(banner.mock.lastCall?.[1].createdAt).not.toBe(initialReportTime);
  expect(banner.mock.lastCall?.[0]).toBe(initialBannerId);
  expect(refresh).toHaveBeenCalledTimes(1);
  await screen.rerender(probe(false));
  await act(() => vi.advanceTimersByTime(600_000));
  expect(refresh).toHaveBeenCalledTimes(1);
  await screen.rerender(probe(true));
  expect(refresh).toHaveBeenCalledTimes(2);
  for (const href of ["/settings", "/usage"]) {
    await act(() => screen.router!.navigate({ href }));
    await act(() => vi.advanceTimersByTime(600_000));
    expect(refresh).toHaveBeenCalledTimes(2);
  }
  await act(() => screen.router!.navigate({ href: "/environment-one/thread-one" }));
  expect(refresh).toHaveBeenCalledTimes(3);
});
