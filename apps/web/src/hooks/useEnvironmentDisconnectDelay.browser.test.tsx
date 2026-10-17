import { EnvironmentId } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { useEnvironmentDisconnectDelay } from "./useEnvironmentDisconnectDelay";

const environmentId = EnvironmentId.make("remote");
let root: Root;
let container: HTMLDivElement;

function Probe({ unavailableId }: { unavailableId: EnvironmentId | null }) {
  return <>{useEnvironmentDisconnectDelay(unavailableId) ? "Disconnected" : "Waiting"}</>;
}

const shown = () => container.textContent;
const render = (unavailableId: EnvironmentId | null) =>
  act(() => root.render(<Probe unavailableId={unavailableId} />));

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  root = createRoot(container);
  render(environmentId);
});

afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("waits 20 seconds without restarting on renders for the same environment", () => {
  act(() => vi.advanceTimersByTime(10_000));
  expect(shown()).toBe("Waiting");
  render(environmentId);
  act(() => vi.advanceTimersByTime(9_999));
  expect(shown()).toBe("Waiting");
  act(() => vi.advanceTimersByTime(1));
  expect(shown()).toBe("Disconnected");
});

it("cancels a brief outage and starts a fresh delay on the next outage", () => {
  act(() => vi.advanceTimersByTime(10_000));
  render(null);
  act(() => vi.advanceTimersByTime(20_000));
  expect(shown()).toBe("Waiting");
  render(environmentId);
  act(() => vi.advanceTimersByTime(19_999));
  expect(shown()).toBe("Waiting");
  act(() => vi.advanceTimersByTime(1));
  expect(shown()).toBe("Disconnected");
  render(null);
  expect(shown()).toBe("Waiting");
});

it("does not carry elapsed time to another environment", () => {
  act(() => vi.advanceTimersByTime(20_000));
  expect(shown()).toBe("Disconnected");
  render(EnvironmentId.make("another-remote"));
  expect(shown()).toBe("Waiting");
  act(() => vi.advanceTimersByTime(20_000));
  expect(shown()).toBe("Disconnected");
});
