import { Linking } from "react-native";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { tryOpenExternalUrl, tryOpenWebLink } from "./openExternalUrl";

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

describe("tryOpenWebLink", () => {
  it("opens web, mail and phone links only", async () => {
    openURL.mockResolvedValue(undefined);
    for (const url of ["https://example.com/a", "HTTP://example.com", "mailto:a@example.com"]) {
      await expect(tryOpenWebLink(url, "pull-request")).resolves.toBe(true);
    }
    for (const url of ["otherapp://open", "intent://x#Intent;end", "/owner/repo", ""]) {
      await expect(tryOpenWebLink(url, "pull-request")).resolves.toBe(false);
    }
    expect(openURL).toHaveBeenCalledTimes(3);
  });
});
