import { describe, expect, it } from "vite-plus/test";

import { AuthSessionId } from "./baseSchemas.ts";
import { AuthAccessStreamError } from "./auth.ts";

describe("AuthAccessStreamError", () => {
  it("preserves the pairing-link list failure", () => {
    const cause = new Error("database unavailable");
    const error = new AuthAccessStreamError({
      operation: "list-pairing-links",
      cause,
    });

    expect(error.operation).toBe("list-pairing-links");
    expect(error.currentSessionId).toBeUndefined();
    expect(error.cause).toBe(cause);
    expect(error.message).toBe("Authentication access stream operation list-pairing-links failed.");
    expect(error.message).not.toContain(cause.message);
  });

  it("preserves the current session for client-session list failures", () => {
    const cause = new Error("database unavailable");
    const currentSessionId = AuthSessionId.make("session-current");
    const error = new AuthAccessStreamError({
      operation: "list-client-sessions",
      currentSessionId,
      cause,
    });

    expect(error.operation).toBe("list-client-sessions");
    expect(error.currentSessionId).toBe(currentSessionId);
    expect(error.cause).toBe(cause);
    expect(error.message).toBe(
      "Authentication access stream operation list-client-sessions failed for session session-current.",
    );
    expect(error.message).not.toContain(cause.message);
  });
});
