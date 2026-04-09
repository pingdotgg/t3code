import { describe, expect, it } from "vitest";

import { normalizeDesktopUpdateError } from "./updateErrors";

describe("normalizeDesktopUpdateError", () => {
  it("maps network-style check errors to a friendly message", () => {
    expect(normalizeDesktopUpdateError(new Error("net::ERR_CONNECTION_REFUSED"), "check")).toEqual({
      message: "Couldn't reach the update server. Check your connection and try again.",
      rawMessage: "net::ERR_CONNECTION_REFUSED",
      toastAction: null,
    });
  });

  it("maps checksum download failures to a retryable message", () => {
    expect(
      normalizeDesktopUpdateError(
        new Error("sha512 checksum mismatch, expected abc but got def"),
        "download",
      ),
    ).toEqual({
      message: "The downloaded update could not be verified. Try downloading it again.",
      rawMessage: "sha512 checksum mismatch, expected abc but got def",
      toastAction: {
        kind: "desktop-update.retry-download",
        label: "Retry download",
      },
    });
  });

  it("falls back to the raw message when it is already useful", () => {
    expect(
      normalizeDesktopUpdateError(new Error("Release feed returned malformed JSON"), "check"),
    ).toEqual({
      message: "Release feed returned malformed JSON",
      rawMessage: "Release feed returned malformed JSON",
      toastAction: null,
    });
  });
});
