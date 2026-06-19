import { describe, expect, it } from "vite-plus/test";

import {
  isInterruptArtifactErrorMessage,
  isTransportConnectionErrorMessage,
  sanitizeThreadErrorMessage,
} from "./transport.ts";

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
    expect(
      isTransportConnectionErrorMessage(
        "Test environment could not establish a WebSocket connection.",
      ),
    ).toBe(true);
    expect(isTransportConnectionErrorMessage("Test environment is not connected.")).toBe(true);
    expect(isTransportConnectionErrorMessage("ClientProtocolError: socket closed")).toBe(true);
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

describe("isInterruptArtifactErrorMessage", () => {
  it("returns true for the Claude SDK ede_diagnostic interrupt artifact", () => {
    expect(
      isInterruptArtifactErrorMessage(
        "[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use",
      ),
    ).toBe(true);
  });

  it("returns true for the OpenCode bare Aborted message", () => {
    expect(isInterruptArtifactErrorMessage("Aborted")).toBe(true);
    expect(isInterruptArtifactErrorMessage("aborted")).toBe(true);
    expect(isInterruptArtifactErrorMessage("Aborted.")).toBe(true);
    expect(isInterruptArtifactErrorMessage("  Aborted  ")).toBe(true);
    expect(isInterruptArtifactErrorMessage("AbortError: Aborted")).toBe(true);
  });

  it("returns false for errors that merely mention aborted", () => {
    expect(isInterruptArtifactErrorMessage("The request was aborted by the server")).toBe(false);
    expect(isInterruptArtifactErrorMessage("Aborted because the file was missing")).toBe(false);
  });

  it("returns false for business logic errors", () => {
    expect(isInterruptArtifactErrorMessage("Thread not found")).toBe(false);
    expect(isInterruptArtifactErrorMessage("Claude turn failed.")).toBe(false);
  });

  it("returns false for null, undefined, and empty strings", () => {
    expect(isInterruptArtifactErrorMessage(null)).toBe(false);
    expect(isInterruptArtifactErrorMessage(undefined)).toBe(false);
    expect(isInterruptArtifactErrorMessage("")).toBe(false);
    expect(isInterruptArtifactErrorMessage("   ")).toBe(false);
  });
});

describe("sanitizeThreadErrorMessage", () => {
  it("strips transport errors", () => {
    expect(sanitizeThreadErrorMessage("SocketCloseError: oops")).toBeNull();
  });

  it("strips interrupt diagnostic artifacts", () => {
    expect(
      sanitizeThreadErrorMessage(
        "[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use",
      ),
    ).toBeNull();
  });

  it("strips OpenCode Aborted interrupt messages", () => {
    expect(sanitizeThreadErrorMessage("Aborted")).toBeNull();
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
