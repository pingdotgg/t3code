import { describe, expect, it } from "vite-plus/test";

import {
  ClerkPublishableKeyDecodeError,
  ClerkPublishableKeyFrontendApiError,
  clerkFrontendApiHostnameFromPublishableKey,
  clerkFrontendApiUrlFromPublishableKey,
  isAllowedClerkFrontendApiHostname,
} from "./relayAuth.ts";

const clerkPublishableKey = (hostname: string): string => `pk_test_${btoa(`${hostname}$`)}`;

const captureError = (run: () => unknown): unknown => {
  try {
    run();
  } catch (cause) {
    return cause;
  }
  throw new Error("Expected operation to throw");
};

describe("Clerk relay auth", () => {
  it("derives a custom Frontend API hostname from a Clerk publishable key", () => {
    expect(clerkFrontendApiHostnameFromPublishableKey(clerkPublishableKey("clerk.t3.codes"))).toBe(
      "clerk.t3.codes",
    );
    expect(clerkFrontendApiUrlFromPublishableKey(clerkPublishableKey("clerk.t3.codes"))).toBe(
      "https://clerk.t3.codes",
    );
  });

  it("preserves Clerk publishable key decoding failures", () => {
    const error = captureError(() => clerkFrontendApiUrlFromPublishableKey("pk_test_%"));

    expect(error).toBeInstanceOf(ClerkPublishableKeyDecodeError);
    expect(error).toMatchObject({ keyPrefix: "pk_test" });
    expect((error as ClerkPublishableKeyDecodeError).cause).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("Failed to decode Clerk publishable key (pk_test).");
  });

  it("reports semantic frontend API failures without inventing a cause", () => {
    const emptyError = captureError(() => clerkFrontendApiUrlFromPublishableKey("pk_test_"));
    const pathFrontendApi = "clerk.t3.codes/path";
    const pathError = captureError(() =>
      clerkFrontendApiUrlFromPublishableKey(clerkPublishableKey(pathFrontendApi)),
    );

    expect(emptyError).toBeInstanceOf(ClerkPublishableKeyFrontendApiError);
    expect(emptyError).toMatchObject({
      keyPrefix: "pk_test",
      frontendApi: "",
      reason: "empty",
    });
    expect((emptyError as Error & { cause?: unknown }).cause).toBeUndefined();
    expect(pathError).toBeInstanceOf(ClerkPublishableKeyFrontendApiError);
    expect(pathError).toMatchObject({
      keyPrefix: "pk_test",
      frontendApi: pathFrontendApi,
      reason: "contains-path",
    });
    expect((pathError as Error & { cause?: unknown }).cause).toBeUndefined();
  });

  it("preserves URL parser failures for decoded frontend APIs", () => {
    const frontendApi = "[invalid-host";
    const error = captureError(() =>
      clerkFrontendApiHostnameFromPublishableKey(clerkPublishableKey(frontendApi)),
    );

    expect(error).toBeInstanceOf(ClerkPublishableKeyFrontendApiError);
    expect(error).toMatchObject({
      keyPrefix: "pk_test",
      frontendApi,
      reason: "invalid-url",
    });
    expect((error as ClerkPublishableKeyFrontendApiError).cause).toBeInstanceOf(Error);
  });

  it("allows standard Clerk hosts and an exact configured custom hostname", () => {
    expect(isAllowedClerkFrontendApiHostname("example.clerk.accounts.dev", null)).toBe(true);
    expect(isAllowedClerkFrontendApiHostname("example.clerk.accounts.com", null)).toBe(true);
    expect(isAllowedClerkFrontendApiHostname("clerk.t3.codes", "clerk.t3.codes")).toBe(true);
    expect(isAllowedClerkFrontendApiHostname("attacker.example", "clerk.t3.codes")).toBe(false);
    expect(isAllowedClerkFrontendApiHostname("nested.clerk.t3.codes", "clerk.t3.codes")).toBe(
      false,
    );
  });
});
