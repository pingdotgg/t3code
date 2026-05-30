import { describe, expect, it, vi } from "vitest";

import { redactPairingCredential } from "./connection";

vi.mock("./runtime", () => ({
  mobileRemoteHttpRuntime: {
    runPromise: vi.fn(),
  },
}));

describe("mobile remote connection records", () => {
  it("removes one-time bootstrap credentials before persisting pairing URLs", () => {
    expect(redactPairingCredential("https://desktop.example/#token=bootstrap-token")).toBe(
      "https://desktop.example/",
    );
    expect(redactPairingCredential("https://desktop.example/?token=bootstrap-token")).toBe(
      "https://desktop.example/",
    );
  });

  it("removes hosted pairing credentials while keeping the advertised host", () => {
    expect(
      redactPairingCredential(
        "https://app.t3.codes/pair?host=https%3A%2F%2Fdesktop.example&token=bootstrap-token&label=Desktop",
      ),
    ).toBe("https://app.t3.codes/pair?host=https%3A%2F%2Fdesktop.example&label=Desktop");
  });
});
