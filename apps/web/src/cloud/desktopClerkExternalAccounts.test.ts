import { describe, expect, it, vi } from "vitest";

import {
  makeDesktopClerkExternalAccountAdapter,
  type DesktopClerkUser,
} from "./desktopClerkExternalAccounts";

describe("desktop Clerk external account adapter", () => {
  it("replaces renderer redirects with native callbacks and reloads the user on return", async () => {
    const callbacks: ((rawUrl: string) => void)[] = [];
    const callbackCleanup = vi.fn();
    const bridge = {
      createCloudAuthRequest: vi
        .fn()
        .mockResolvedValueOnce("t3code://auth/callback?t3_state=add")
        .mockResolvedValueOnce("t3code://auth/callback?t3_state=reconnect"),
      onCloudAuthCallback: vi.fn((listener: (rawUrl: string) => void) => {
        callbacks.push(listener);
        return callbackCleanup;
      }),
    };
    const reauthorize = vi.fn(async (_params: Record<string, unknown>) => account);
    const account = { reauthorize };
    const createExternalAccount = vi.fn(async (_params: Record<string, unknown>) => account);
    const reload = vi.fn(async () => undefined);
    const user = {
      externalAccounts: [],
      createExternalAccount,
      reload,
    } satisfies DesktopClerkUser;
    const adapter = makeDesktopClerkExternalAccountAdapter({ bridge });
    adapter.installUser(user);

    await user.createExternalAccount({
      redirectUrl: "http://127.0.0.1:3773/?__clerk_modal_state=state",
      strategy: "oauth_microsoft",
    });

    expect(createExternalAccount).toHaveBeenCalledWith({
      redirectUrl: "t3code://auth/callback?t3_state=add",
      strategy: "oauth_microsoft",
    });

    callbacks[0]?.("t3code://auth/callback?t3_state=add");
    await Promise.resolve();
    expect(reload).toHaveBeenCalledOnce();

    await account.reauthorize({
      redirectUrl: "http://127.0.0.1:3773/?__clerk_modal_state=state",
    });
    expect(reauthorize).toHaveBeenCalledWith({
      redirectUrl: "t3code://auth/callback?t3_state=reconnect",
    });
  });

  it("cleans up the pending callback when Clerk rejects account creation", async () => {
    const callbackCleanup = vi.fn();
    const bridge = {
      createCloudAuthRequest: vi.fn().mockResolvedValue("t3code://auth/callback?t3_state=failed"),
      onCloudAuthCallback: vi.fn(() => callbackCleanup),
    };
    const createError = new Error("oauth provider unavailable");
    const user = {
      externalAccounts: [],
      createExternalAccount: vi.fn(async (_params: Record<string, unknown>) => {
        throw createError;
      }),
      reload: vi.fn(async () => undefined),
    } satisfies DesktopClerkUser;
    const adapter = makeDesktopClerkExternalAccountAdapter({ bridge });
    adapter.installUser(user);

    await expect(user.createExternalAccount({ strategy: "oauth_microsoft" })).rejects.toBe(
      createError,
    );
    expect(callbackCleanup).toHaveBeenCalledOnce();
  });
});
