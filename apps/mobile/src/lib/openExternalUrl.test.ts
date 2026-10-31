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

  it("opens only web and mail links from untrusted text", async () => {
    openURL.mockResolvedValue(undefined);
    for (const url of ["javascript:alert(1)", "tel:123", "t3code://pair", "file:///etc/hosts"]) {
      await expect(tryOpenWebLink(url, "markdown-link")).resolves.toBe(false);
    }
    expect(openURL).not.toHaveBeenCalled();
    for (const url of ["https://linear.app/t/issue/ATT-1", "HTTP://x.test", "mailto:a@b.test"]) {
      await expect(tryOpenWebLink(url, "markdown-link")).resolves.toBe(true);
    }
    expect(openURL).toHaveBeenCalledTimes(3);
  });
});
