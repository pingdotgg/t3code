import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const clerk = vi.hoisted(() => ({ openSignIn: vi.fn() }));

vi.mock("@clerk/react", () => ({
  useClerk: () => clerk,
}));

vi.mock("../../env", () => ({ isElectron: true }));

import { CONNECT_ONBOARDING_AUTH_PENDING_STORAGE_KEY } from "../../cloud/connectOnboarding";
import { useT3ConnectAuthPrompt } from "./useT3ConnectAuthPrompt";

const sessionStorage = {
  setItem: vi.fn(),
};

describe("useT3ConnectAuthPrompt", () => {
  beforeEach(() => {
    clerk.openSignIn.mockClear();
    sessionStorage.setItem.mockClear();
    vi.stubGlobal("window", {
      location: { href: "t3code-dev://app/#/settings/connections" },
      sessionStorage,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("marks onboarding as pending before desktop auth redirects", () => {
    useT3ConnectAuthPrompt().openAuthPrompt();

    expect(sessionStorage.setItem).toHaveBeenCalledWith(
      CONNECT_ONBOARDING_AUTH_PENDING_STORAGE_KEY,
      "1",
    );
    expect(sessionStorage.setItem.mock.invocationCallOrder[0]).toBeLessThan(
      clerk.openSignIn.mock.invocationCallOrder[0] ?? 0,
    );
    expect(clerk.openSignIn).toHaveBeenCalledWith({
      forceRedirectUrl: "t3code-dev://app/#/settings/connections",
      signUpForceRedirectUrl: "t3code-dev://app/#/settings/connections",
    });
  });

  it.each(["SecurityError", "QuotaExceededError"])(
    "opens sign-in when session storage writes fail with %s",
    (name) => {
      sessionStorage.setItem.mockImplementationOnce(() => {
        throw new DOMException("Session storage is unavailable", name);
      });

      useT3ConnectAuthPrompt().openAuthPrompt();

      expect(clerk.openSignIn).toHaveBeenCalledOnce();
    },
  );

  it("opens sign-in when session storage is unavailable", () => {
    Object.defineProperty(window, "sessionStorage", {
      get() {
        throw new DOMException("Session storage is unavailable", "SecurityError");
      },
    });

    useT3ConnectAuthPrompt().openAuthPrompt();

    expect(clerk.openSignIn).toHaveBeenCalledOnce();
  });
});
