import { describe, expect, it } from "vite-plus/test";

import {
  formatSectionContext,
  makeSectionCredential,
  parseSectionContext,
} from "./sectionCredentials";

describe("sectionCredentials", () => {
  it("round-trips username and password credentials", () => {
    const formatted = formatSectionContext({
      context: "Use the media server.",
      credential: {
        type: "username-password",
        username: "agent@example.com",
        password: "secret\nwith newline",
      },
    });

    expect(parseSectionContext(formatted)).toEqual({
      context: "Use the media server.",
      credential: {
        type: "username-password",
        username: "agent@example.com",
        password: "secret\nwith newline",
      },
    });
  });

  it("round-trips a secret key without other context", () => {
    const formatted = formatSectionContext({
      context: "",
      credential: { type: "secret-key", key: "key-value" },
    });

    expect(parseSectionContext(formatted)).toEqual({
      context: "",
      credential: { type: "secret-key", key: "key-value" },
    });
  });

  it("leaves ordinary and malformed context unchanged", () => {
    expect(parseSectionContext("Ordinary context")).toEqual({
      context: "Ordinary context",
      credential: null,
    });
    expect(
      parseSectionContext(
        "<!-- morecode-section-credentials:start -->\nnot json\n<!-- morecode-section-credentials:end -->",
      ),
    ).toEqual({
      context:
        "<!-- morecode-section-credentials:start -->\nnot json\n<!-- morecode-section-credentials:end -->",
      credential: null,
    });
  });

  it("builds credentials from form state", () => {
    expect(
      makeSectionCredential({
        type: "username-password",
        username: "user",
        password: "pass",
        secretKey: "unused",
      }),
    ).toEqual({ type: "username-password", username: "user", password: "pass" });
    expect(
      makeSectionCredential({
        type: "secret-key",
        username: "unused",
        password: "unused",
        secretKey: "key",
      }),
    ).toEqual({ type: "secret-key", key: "key" });
    expect(
      makeSectionCredential({
        type: "none",
        username: "",
        password: "",
        secretKey: "",
      }),
    ).toBeNull();
  });
});
