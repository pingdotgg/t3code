import { EnvironmentId, ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { act, fakeTimers, render } from "../../test/render";
import { BackgroundThreadContext } from "../components/chat/backgroundThread";
import { useUsageLimitsRefresh } from "./useUsageLimitsRefresh";

const mocks = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => mocks.refresh }));
vi.mock("../state/server", () => ({ serverEnvironment: { refreshProviders: {} } }));
vi.mock("../state/presentation", async () => {
  const { Atom } = await import("effect/reactivity");
  const presentation = Atom.make({ connection: { phase: "connected" } });
  return { environmentPresentations: { presentationAtom: () => presentation } };
});

function setup() {
  mocks.refresh.mockReset();
  return mocks;
}

function Probe() {
  useUsageLimitsRefresh(
    EnvironmentId.make("retained-usage"),
    ProviderInstanceId.make("cursor-retained"),
    true,
    ProviderDriverKind.make("cursor"),
  );
  return null;
}

it("pauses a retained report under Settings and Usage, then refreshes on return", async () => {
  const { refresh } = setup();
  using _timers = fakeTimers({ now: 4_000_000 });
  await using screen = await render(
    <BackgroundThreadContext value>
      <Probe />
    </BackgroundThreadContext>,
    { router: "/environment-one/thread-one" },
  );
  expect(refresh).toHaveBeenCalledTimes(1);
  for (const href of ["/settings", "/usage"]) {
    await act(() => screen.router!.navigate({ href }));
    await act(() => vi.advanceTimersByTime(600_000));
    expect(refresh).toHaveBeenCalledTimes(1);
  }
  await act(() => screen.router!.navigate({ href: "/environment-one/thread-one" }));
  expect(refresh).toHaveBeenCalledTimes(2);
});
