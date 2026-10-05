import { describe, expect, it } from "vite-plus/test";

import { NETWORK_BLOCKING_HINT } from "./network.ts";
import { isTransportConnectionErrorMessage, sanitizeThreadErrorMessage } from "./transport.ts";

describe("isTransportConnectionErrorMessage", () => {
  it("returns true for SocketCloseError", () => {
    expect(isTransportConnectionErrorMessage("SocketCloseError: connection reset")).toBe(true);
  });

  it("returns true for SocketOpenError", () => {
    expect(isTransportConnectionErrorMessage("SocketOpenError: ECONNREFUSED")).toBe(true);
  });

  it("returns true for React Native disconnected socket errors", () => {
    expect(
      isTransportConnectionErrorMessage(
        "The operation couldn't be completed. Socket is not connected",
      ),
    ).toBe(true);
  });

  it("recognizes connection errors emitted by the Effect RPC session", () => {
    expect(isTransportConnectionErrorMessage("Test environment disconnected.")).toBe(true);
    expect(isTransportConnectionErrorMessage("Test environment stopped responding.")).toBe(true);
    expect(
      isTransportConnectionErrorMessage(
        "Test environment could not establish a WebSocket connection.",
      ),
    ).toBe(true);
    expect(isTransportConnectionErrorMessage("Test environment is not connected.")).toBe(true);
    expect(isTransportConnectionErrorMessage("ClientProtocolError: socket closed")).toBe(true);
  });

  it("recognizes relay connection errors that carry the network hint", () => {
    for (const sentence of [
      "Relay environment disconnected.",
      "Relay environment stopped responding.",
      "Relay environment could not establish a WebSocket connection.",
    ]) {
      expect(isTransportConnectionErrorMessage(`${sentence} ${NETWORK_BLOCKING_HINT}`)).toBe(true);
    }
    expect(
      isTransportConnectionErrorMessage(
        "Your ChatGPT connection expired or was disconnected. Sign in again.",
      ),
    ).toBe(false);
  });

  it("returns true for the T3 server WebSocket message", () => {
    expect(isTransportConnectionErrorMessage("Unable to connect to the T3 server WebSocket.")).toBe(
      true,
    );
  });

  it("returns true for ping timeout", () => {
    expect(isTransportConnectionErrorMessage("ping timeout")).toBe(true);
  });

  it("returns false for business logic errors", () => {
    expect(isTransportConnectionErrorMessage("Thread not found")).toBe(false);
    expect(isTransportConnectionErrorMessage("Invalid model selection")).toBe(false);
  });

  it("returns false for null, undefined, and empty strings", () => {
    expect(isTransportConnectionErrorMessage(null)).toBe(false);
    expect(isTransportConnectionErrorMessage(undefined)).toBe(false);
    expect(isTransportConnectionErrorMessage("")).toBe(false);
    expect(isTransportConnectionErrorMessage("   ")).toBe(false);
  });
});

describe("sanitizeThreadErrorMessage", () => {
  it("strips transport errors", () => {
    expect(sanitizeThreadErrorMessage("SocketCloseError: oops")).toBeNull();
  });

  it("preserves non-transport errors", () => {
    expect(sanitizeThreadErrorMessage("Thread not found")).toBe("Thread not found");
    expect(sanitizeThreadErrorMessage("Select a base branch before sending.")).toBe(
      "Select a base branch before sending.",
    );
  });

  it("returns null for null/undefined", () => {
    expect(sanitizeThreadErrorMessage(null)).toBeNull();
    expect(sanitizeThreadErrorMessage(undefined)).toBeNull();
  });
});
