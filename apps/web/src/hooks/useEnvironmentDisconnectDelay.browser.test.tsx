import { act, fakeTimers, render } from "../../test/render";
import { EnvironmentId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { useEnvironmentDisconnectDelay } from "./useEnvironmentDisconnectDelay";

const environmentId = EnvironmentId.make("remote");
function Probe({ unavailableId }: { unavailableId: EnvironmentId | null }) {
  return <>{useEnvironmentDisconnectDelay(unavailableId) ? "Disconnected" : "Waiting"}</>;
}

it("waits 20 seconds without restarting on renders for the same environment", async () => {
  using _timers = fakeTimers();
  await using screen = await render(<Probe unavailableId={environmentId} />, { router: false });
  const shown = () => screen.container.textContent;
  await act(() => vi.advanceTimersByTime(10_000));
  expect(shown()).toBe("Waiting");
  await screen.rerender(<Probe unavailableId={environmentId} />);
  await act(() => vi.advanceTimersByTime(9_999));
  expect(shown()).toBe("Waiting");
  await act(() => vi.advanceTimersByTime(1));
  expect(shown()).toBe("Disconnected");
});

it("cancels a brief outage and starts a fresh delay on the next outage", async () => {
  using _timers = fakeTimers();
  await using screen = await render(<Probe unavailableId={environmentId} />, { router: false });
  const shown = () => screen.container.textContent;
  await act(() => vi.advanceTimersByTime(10_000));
  await screen.rerender(<Probe unavailableId={null} />);
  await act(() => vi.advanceTimersByTime(20_000));
  expect(shown()).toBe("Waiting");
  await screen.rerender(<Probe unavailableId={environmentId} />);
  await act(() => vi.advanceTimersByTime(19_999));
  expect(shown()).toBe("Waiting");
  await act(() => vi.advanceTimersByTime(1));
  expect(shown()).toBe("Disconnected");
  await screen.rerender(<Probe unavailableId={null} />);
  expect(shown()).toBe("Waiting");
});

it("does not carry elapsed time to another environment", async () => {
  using _timers = fakeTimers();
  await using screen = await render(<Probe unavailableId={environmentId} />, { router: false });
  const shown = () => screen.container.textContent;
  await act(() => vi.advanceTimersByTime(20_000));
  expect(shown()).toBe("Disconnected");
  await screen.rerender(<Probe unavailableId={EnvironmentId.make("another-remote")} />);
  expect(shown()).toBe("Waiting");
  await act(() => vi.advanceTimersByTime(20_000));
  expect(shown()).toBe("Disconnected");
});
