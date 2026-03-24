import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi, beforeAll } from "vitest";
import { ConnectionStatusBanner } from "./ConnectionStatusBanner";

// Mock wsNativeApi
vi.mock("../../wsNativeApi", () => {
  return {
    onTransportStateChange: vi.fn(() => {
      return () => {};
    }),
  };
});

describe("ConnectionStatusBanner", () => {
  beforeAll(() => {
    vi.stubGlobal("navigator", {
      onLine: true,
    });
  });

  it("renders nothing when online and transport is open", () => {
    const markup = renderToStaticMarkup(
      <ConnectionStatusBanner initialIsOnline={true} initialTransportState="open" />,
    );
    expect(markup).toBe("");
  });

  it("renders offline message when initialIsOnline is false", async () => {
    const markup = renderToStaticMarkup(
      <ConnectionStatusBanner initialIsOnline={false} initialTransportState="open" />,
    );
    expect(markup).toContain("No internet connection");
    expect(markup).toContain("T3 Code is offline");
  });

  it("renders disconnected message when initialTransportState is closed", async () => {
    const markup = renderToStaticMarkup(
      <ConnectionStatusBanner initialIsOnline={true} initialTransportState="closed" />,
    );
    expect(markup).toContain("Disconnected from server");
    expect(markup).toContain("connection to the T3 Code server was lost");
  });

  it("renders reconnecting message when initialTransportState is reconnecting", async () => {
    const markup = renderToStaticMarkup(
      <ConnectionStatusBanner initialIsOnline={true} initialTransportState="reconnecting" />,
    );
    expect(markup).toContain("Disconnected from server");
    expect(markup).toContain("Attempting to reconnect");
  });

  it("renders nothing when transport is disposed", () => {
    const markup = renderToStaticMarkup(
      <ConnectionStatusBanner initialIsOnline={true} initialTransportState="disposed" />,
    );
    expect(markup).toBe("");
  });
});
