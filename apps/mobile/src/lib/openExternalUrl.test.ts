import { Linking } from "react-native";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { tryOpenExternalUrl } from "./openExternalUrl";

vi.mock("react-native", () => ({
  Linking: { openURL: vi.fn() },
}));

const openURL = vi.mocked(Linking.openURL);

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("tryOpenExternalUrl", () => {
  it("opens supported URLs", async () => {
    openURL.mockResolvedValue(undefined);

    await expect(
      tryOpenExternalUrl("https://github.com/pingdotgg/t3code", "pull-request"),
    ).resolves.toBe(true);
  });

  it("logs stable URL context without exposing the opening failure", async () => {
    const cause = new Error("browser-unavailable-secret-sentinel");
    openURL.mockRejectedValue(cause);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      tryOpenExternalUrl("https://github.com/pingdotgg/t3code/pull/1?token=secret", "pull-request"),
    ).resolves.toBe(false);

    expect(consoleError).toHaveBeenCalledTimes(1);
    const [message, attributes] = consoleError.mock.calls[0] ?? [];
    expect(message).toBe("Failed to open pull-request URL with the https scheme.");
    expect(attributes).toEqual(
      expect.objectContaining({
        _tag: "ExternalUrlOpenError",
        target: "pull-request",
        scheme: "https",
        host: "github.com",
        stack: expect.stringContaining("ExternalUrlOpenError"),
      }),
    );
    expect(attributes).not.toHaveProperty("url");
    expect(attributes).not.toHaveProperty("cause");
    const diagnosticText = [message, ...Object.values(attributes as Record<string, unknown>)]
      .map(String)
      .join("\n");
    expect(diagnosticText).not.toContain("token=secret");
    expect(diagnosticText).not.toContain("browser-unavailable-secret-sentinel");
  });

  it("keeps provider sign-in URLs unchanged and out of failure logs", async () => {
    const url =
      "https://accounts.google.com/o/oauth2/v2/auth?state=private-state&code_challenge=private-challenge&redirect_uri=http%3A%2F%2F127.0.0.1%3A43123%2F";
    openURL.mockRejectedValue(new Error(`Cannot open ${url}`));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(tryOpenExternalUrl(url, "provider-auth")).resolves.toBe(false);

    expect(openURL).toHaveBeenCalledWith(url);
    const diagnostics = JSON.stringify(consoleError.mock.calls);
    expect(diagnostics).toContain("accounts.google.com");
    expect(diagnostics).not.toContain("private-state");
    expect(diagnostics).not.toContain("private-challenge");
    expect(diagnostics).not.toContain("43123");
  });
});
