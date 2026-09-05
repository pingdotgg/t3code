import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const testState = vi.hoisted(() => ({
  presentations: new Map() as ReadonlyMap<unknown, unknown>,
  addToast: vi.fn(() => "toast"),
  closeToast: vi.fn(),
  navigate: vi.fn(),
}));

vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => testState.presentations,
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => testState.navigate,
}));
vi.mock("../hooks/useNowMinute", () => ({
  useNowMinute: () => "2026-09-03T12:00",
}));
vi.mock("../state/presentation", () => ({
  environmentPresentations: { presentationsAtom: {} },
}));
vi.mock("./settings/providerDriverMeta", () => ({
  getDriverOption: () => ({ label: "Codex" }),
}));
vi.mock("./ui/toast", () => ({
  stackedThreadToast: (toast: unknown) => toast,
  toastManager: {
    add: testState.addToast,
    close: testState.closeToast,
  },
}));

import { ResetCreditExpiryNotification } from "./ResetCreditExpiryNotification";

let root: Root;

function presentations(expiresAt: string, phase: "connected" | "reconnecting" = "connected") {
  return new Map([
    [
      "env-a",
      {
        entry: { target: { label: "Laptop" } },
        connection: { phase },
        serverConfig: {
          providers: [
            {
              instanceId: "codex",
              driver: "codex",
              enabled: true,
              installed: true,
              auth: { status: "authenticated", email: "person@example.com" },
              usageLimits: {
                resetCredits: { availableCount: 1, nextExpiresAt: expiresAt },
              },
            },
          ],
        },
      },
    ],
  ]);
}

async function render(presentationState: ReturnType<typeof presentations>) {
  testState.presentations = presentationState;
  await act(() => {
    root.render(
      <StrictMode>
        <ResetCreditExpiryNotification />
      </StrictMode>,
    );
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  testState.addToast.mockReset().mockReturnValueOnce("toast-a").mockReturnValueOnce("toast-b");
  testState.closeToast.mockReset();
  testState.navigate.mockReset();

  const document = {
    nodeType: 9,
    addEventListener() {},
    removeEventListener() {},
  };
  const container = {
    nodeType: 1,
    tagName: "DIV",
    namespaceURI: "http://www.w3.org/1999/xhtml",
    ownerDocument: document,
    addEventListener() {},
    removeEventListener() {},
  };
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", {
    document,
    HTMLIFrameElement: EventTarget,
    setTimeout,
    clearTimeout,
  });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  root = createRoot(container as unknown as HTMLElement);
});

afterEach(async () => {
  await act(() => root.unmount());
  await vi.runOnlyPendingTimersAsync();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("ResetCreditExpiryNotification", () => {
  it("retains one toast while settling, then replaces it after the grace period", async () => {
    await render(presentations("2026-09-04T12:00:00.000Z"));
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    expect(testState.addToast).toHaveBeenCalledTimes(1);

    await render(presentations("2026-09-05T12:00:00.000Z", "reconnecting"));
    await act(() => vi.advanceTimersByTimeAsync(29_999));
    expect(testState.closeToast).not.toHaveBeenCalled();
    expect(testState.addToast).toHaveBeenCalledTimes(1);

    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(testState.closeToast).toHaveBeenCalledWith("toast-a");
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    expect(testState.addToast).toHaveBeenCalledTimes(2);
  });
});
