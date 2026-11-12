import { expect, it, vi } from "vite-plus/test";

import { act, fakeTimers, render, stubGlobal } from "../../test/render";
import { useAppleSpeechAvailable } from "./appleSpeech";

function Availability() {
  return <span>{useAppleSpeechAvailable() ? "available" : "unavailable"}</span>;
}

it("probes Apple Speech again for a mounted view after a 'not available' answer", async () => {
  let answerFirstProbe!: (available: boolean) => void;
  const isAvailable = vi
    .fn<() => Promise<boolean>>()
    .mockReturnValueOnce(new Promise((resolve) => (answerFirstProbe = resolve)))
    .mockResolvedValue(true);
  using _bridge = stubGlobal("desktopBridge", { appleSpeech: { isAvailable } });
  // The hook reads a module store and the desktop bridge, not routes.
  await using screen = await render(<Availability />, { router: false });
  using _timers = fakeTimers();
  await act(() => answerFirstProbe(false));
  await expect.element(screen.getByText("unavailable")).toBeInTheDocument();
  await act(() => vi.advanceTimersByTime(15_000));
  await expect.element(screen.getByText("available", { exact: true })).toBeInTheDocument();
  expect(isAvailable).toHaveBeenCalledTimes(2);
});
