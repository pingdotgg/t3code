import { EnvironmentId } from "@t3tools/contracts";
import { act, useLayoutEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { useEnvironmentDisconnectDelay } from "./useEnvironmentDisconnectDelay";

const environmentId = EnvironmentId.make("remote");
let renderer: ReactTestRenderer;
let elapsed = false;

function Probe({ unavailableId }: { unavailableId: EnvironmentId | null }) {
  const value = useEnvironmentDisconnectDelay(unavailableId);
  useLayoutEffect(() => {
    elapsed = value;
  });
  return null;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  act(() => {
    renderer = create(<Probe unavailableId={environmentId} />);
  });
});

afterEach(() => {
  act(() => renderer.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("waits 20 seconds without restarting on renders for the same environment", () => {
  act(() => vi.advanceTimersByTime(10_000));
  expect(elapsed).toBe(false);
  act(() => renderer.update(<Probe unavailableId={environmentId} />));
  act(() => vi.advanceTimersByTime(9_999));
  expect(elapsed).toBe(false);
  act(() => vi.advanceTimersByTime(1));
  expect(elapsed).toBe(true);
});

it("cancels a brief outage and starts a fresh delay on the next outage", () => {
  act(() => vi.advanceTimersByTime(10_000));
  act(() => renderer.update(<Probe unavailableId={null} />));
  act(() => vi.advanceTimersByTime(20_000));
  expect(elapsed).toBe(false);
  act(() => renderer.update(<Probe unavailableId={environmentId} />));
  act(() => vi.advanceTimersByTime(19_999));
  expect(elapsed).toBe(false);
  act(() => vi.advanceTimersByTime(1));
  expect(elapsed).toBe(true);
  act(() => renderer.update(<Probe unavailableId={null} />));
  expect(elapsed).toBe(false);
});

it("does not carry elapsed time to another environment", () => {
  act(() => vi.advanceTimersByTime(20_000));
  expect(elapsed).toBe(true);
  act(() => renderer.update(<Probe unavailableId={EnvironmentId.make("another-remote")} />));
  expect(elapsed).toBe(false);
  act(() => vi.advanceTimersByTime(20_000));
  expect(elapsed).toBe(true);
});
