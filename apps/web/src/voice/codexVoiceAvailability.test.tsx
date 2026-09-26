import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { act, useLayoutEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  prepared: {} as object | null,
  run: vi.fn<
    (input: unknown, options: { signal: AbortSignal }) => Promise<{ codexVoiceAvailable: boolean }>
  >(),
}));
vi.mock("../state/session", () => ({
  usePreparedConnection: () =>
    mocks.prepared ? { _tag: "Some", value: mocks.prepared } : { _tag: "None" },
}));
vi.mock("../lib/runtime", () => ({ runtime: { runPromise: mocks.run } }));
vi.mock("@t3tools/client-runtime/voice-input", () => ({ voiceAvailability: vi.fn() }));

import { useCodexVoiceAvailability } from "./codexVoiceAvailability";

const environmentId = EnvironmentId.make("env");
const instanceA = ProviderInstanceId.make("codex-a");
const instanceB = ProviderInstanceId.make("codex-b");
let renderer: ReactTestRenderer;
let value: ReturnType<typeof useCodexVoiceAvailability>;
let requests: ReturnType<typeof deferredAvailability>[];

function deferredAvailability() {
  let resolve!: (response: { codexVoiceAvailable: boolean }) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<{ codexVoiceAvailable: boolean }>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function Probe({ instanceId = instanceA, enabled = true }) {
  const availability = useCodexVoiceAvailability(environmentId, instanceId, enabled);
  useLayoutEffect(() => {
    value = availability;
  });
  return null;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("document", Object.assign(new EventTarget(), { visibilityState: "visible" }));
  vi.spyOn(Date, "now").mockReturnValue(30_000);
  mocks.prepared = {};
  requests = [];
  mocks.run.mockReset().mockImplementation(() => {
    const request = deferredAvailability();
    requests.push(request);
    return request.promise;
  });
  act(() => {
    renderer = create(<Probe />);
  });
});

afterEach(() => {
  act(() => renderer.unmount());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each([true, false])(
  "discards cached availability %s when switching A → B → A",
  async (available) => {
    await act(async () => requests[0]!.resolve({ codexVoiceAvailable: available }));
    expect(value.available).toBe(available);
    act(() => renderer.update(<Probe instanceId={instanceB} />));
    expect(value.available).toBeNull();
    act(() => renderer.update(<Probe />));
    expect(value.available).toBeNull();

    await act(async () => requests[1]!.resolve({ codexVoiceAvailable: available }));
    expect(value.available).toBeNull();
    await act(async () => requests[2]!.resolve({ codexVoiceAvailable: !available }));
    expect(value.available).toBe(!available);
  },
);

it("invalidates availability while disabled or disconnected and on reconnect", async () => {
  await act(async () => requests[0]!.resolve({ codexVoiceAvailable: true }));
  act(() => renderer.update(<Probe enabled={false} />));
  expect(value.available).toBe(false);
  act(() => renderer.update(<Probe />));
  expect(value.available).toBeNull();
  await act(async () => requests[1]!.resolve({ codexVoiceAvailable: true }));

  mocks.prepared = null;
  act(() => renderer.update(<Probe />));
  expect(value.available).toBeNull();
  mocks.prepared = {};
  act(() => renderer.update(<Probe />));
  expect(value.available).toBeNull();
  await act(async () => requests[2]!.reject(new Error("unavailable")));
  expect(value.available).toBe(false);
});

it("clears cached availability for a focus probe and preserves throttling", async () => {
  await act(async () => requests[0]!.resolve({ codexVoiceAvailable: true }));
  act(() => value.prepare());
  expect(requests).toHaveLength(1);
  expect(value.available).toBe(true);

  vi.mocked(Date.now).mockReturnValue(45_000);
  act(() => window.dispatchEvent(new Event("focus")));
  expect(value.available).toBeNull();
  await act(async () => requests[1]!.resolve({ codexVoiceAvailable: false }));
  expect(value.available).toBe(false);
});

it.each(["success", "failure"])("ignores an older probe's late %s", async (outcome) => {
  vi.mocked(Date.now).mockReturnValue(45_000);
  act(() => value.prepare());
  expect(requests).toHaveLength(2);
  await act(async () => requests[1]!.resolve({ codexVoiceAvailable: true }));
  await act(async () => {
    if (outcome === "success") requests[0]!.resolve({ codexVoiceAvailable: false });
    else requests[0]!.reject(new Error("old failure"));
  });
  expect(value.available).toBe(true);
});

it("keeps prepare bound to the current effect and ignores aborted responses", async () => {
  const prepare = value.prepare;
  act(() => renderer.update(<Probe instanceId={instanceB} />));
  expect(mocks.run.mock.calls[0]![1].signal.aborted).toBe(true);
  vi.mocked(Date.now).mockReturnValue(45_000);
  act(() => prepare());
  expect(requests).toHaveLength(3);
  expect(mocks.run.mock.calls[2]![1].signal.aborted).toBe(false);
  await act(async () => requests[2]!.resolve({ codexVoiceAvailable: true }));
  await act(async () => requests[0]!.reject(new Error("aborted")));
  expect(value.available).toBe(true);
});
