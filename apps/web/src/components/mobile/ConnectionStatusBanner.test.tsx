import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi, beforeEach } from "vitest";

import { ConnectionStatusBanner } from "./ConnectionStatusBanner";

const mockStatus = {
  attemptCount: 0,
  closeCode: null,
  closeReason: null,
  connectionLabel: null,
  connectedAt: null,
  disconnectedAt: null,
  hasConnected: false,
  lastError: null,
  lastErrorAt: null,
  nextRetryAt: null,
  online: true,
  phase: "idle" as const,
  reconnectAttemptCount: 0,
  reconnectMaxAttempts: 8,
  reconnectPhase: "idle" as const,
  socketUrl: null,
};

vi.mock("~/rpc/wsConnectionState", () => ({
  useWsConnectionStatus: vi.fn(() => mockStatus),
  getWsConnectionUiState: vi.fn((s) => {
    if (s.phase === "connected") return "connected";
    if (!s.online && s.disconnectedAt !== null) return "offline";
    if (!s.hasConnected) return s.phase === "disconnected" ? "error" : "connecting";
    return "reconnecting";
  }),
}));

import { useWsConnectionStatus } from "~/rpc/wsConnectionState";

describe("ConnectionStatusBanner", () => {
  beforeEach(() => {
    vi.mocked(useWsConnectionStatus).mockReturnValue({ ...mockStatus });
  });

  it("renders nothing when connected", () => {
    vi.mocked(useWsConnectionStatus).mockReturnValue({
      ...mockStatus,
      phase: "connected",
      hasConnected: true,
      online: true,
    });
    const markup = renderToStaticMarkup(<ConnectionStatusBanner />);
    expect(markup).toBe("");
  });

  it("renders offline banner when browser is offline and disconnected", () => {
    vi.mocked(useWsConnectionStatus).mockReturnValue({
      ...mockStatus,
      online: false,
      disconnectedAt: new Date().toISOString(),
      phase: "disconnected",
      hasConnected: true,
    });
    const markup = renderToStaticMarkup(<ConnectionStatusBanner />);
    expect(markup).toContain("No internet");
    expect(markup).toContain("bg-warning/10");
  });

  it("renders reconnecting banner when disconnected after prior connection", () => {
    vi.mocked(useWsConnectionStatus).mockReturnValue({
      ...mockStatus,
      online: true,
      phase: "disconnected",
      hasConnected: true,
      disconnectedAt: new Date().toISOString(),
    });
    const markup = renderToStaticMarkup(<ConnectionStatusBanner />);
    expect(markup).toContain("Reconnecting");
  });

  it("renders connection lost banner on error state", () => {
    vi.mocked(useWsConnectionStatus).mockReturnValue({
      ...mockStatus,
      online: true,
      phase: "disconnected",
      hasConnected: false,
    });
    const markup = renderToStaticMarkup(<ConnectionStatusBanner />);
    expect(markup).toContain("Connection lost");
  });

  it("has sm:hidden class so it only shows on mobile", () => {
    vi.mocked(useWsConnectionStatus).mockReturnValue({
      ...mockStatus,
      online: false,
      disconnectedAt: new Date().toISOString(),
      phase: "disconnected",
      hasConnected: true,
    });
    const markup = renderToStaticMarkup(<ConnectionStatusBanner />);
    expect(markup).toContain("sm:hidden");
  });
});
