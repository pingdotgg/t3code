import {
  EnvironmentId,
  PRIMARY_LOCAL_ENVIRONMENT_ID,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  defaultSignInMode,
  describeSignInEvent,
  otherSignInMode,
  providerSignInModes,
  signInActionLabel,
  signOutButtonLabel,
  supportsInAppSignIn,
  switchSignInModeLabel,
} from "./providerSignInFlows";

const PRIMARY_ENVIRONMENT_ID = EnvironmentId.make(PRIMARY_LOCAL_ENVIRONMENT_ID);
const REMOTE_ENVIRONMENT_ID = EnvironmentId.make("relay-abc123");

const provider = (overrides: Partial<ServerProvider>): ServerProvider =>
  ({
    instanceId: "codex",
    driver: "codex",
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "unauthenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  }) as ServerProvider;

describe("defaultSignInMode", () => {
  it("uses the browser only on a desktop client bound to the primary local environment", () => {
    expect(
      defaultSignInMode({
        environmentId: PRIMARY_ENVIRONMENT_ID,
        hasDesktopBridge: true,
      }),
    ).toBe("browser");
  });

  it("falls back to a device code on desktop pointed at a non-primary environment", () => {
    // The OAuth redirect terminates on the machine running codex app-server,
    // which is not this one.
    expect(
      defaultSignInMode({ environmentId: REMOTE_ENVIRONMENT_ID, hasDesktopBridge: true }),
    ).toBe("deviceCode");
  });

  it("falls back to a device code on web in every case", () => {
    for (const environmentId of [PRIMARY_ENVIRONMENT_ID, REMOTE_ENVIRONMENT_ID, null]) {
      expect(defaultSignInMode({ environmentId, hasDesktopBridge: false })).toBe("deviceCode");
    }
  });

  it("falls back to a device code when the environment is not resolved yet", () => {
    expect(defaultSignInMode({ environmentId: null, hasDesktopBridge: true })).toBe("deviceCode");
  });
});

describe("mode switching", () => {
  it("always offers the other mode", () => {
    expect(otherSignInMode("browser")).toBe("deviceCode");
    expect(otherSignInMode("deviceCode")).toBe("browser");
    expect(switchSignInModeLabel("browser")).toBe("Use a device code instead");
    expect(switchSignInModeLabel("deviceCode")).toBe("Use the browser instead");
  });
});

describe("supportsInAppSignIn", () => {
  it("is false without a snapshot, without authMethods, or with an empty list", () => {
    expect(supportsInAppSignIn(undefined)).toBe(false);
    expect(supportsInAppSignIn(provider({}))).toBe(false);
    expect(supportsInAppSignIn(provider({ authMethods: [] }))).toBe(false);
  });

  it("is true once the server advertises a method", () => {
    expect(supportsInAppSignIn(provider({ authMethods: ["deviceCode"] }))).toBe(true);
    expect(providerSignInModes(provider({ authMethods: ["deviceCode"] }))).toEqual(["deviceCode"]);
  });
});

describe("signInActionLabel", () => {
  it("switches wording once an account is attached", () => {
    expect(signInActionLabel(provider({}))).toBe("Sign in");
    expect(signInActionLabel(provider({ auth: { status: "authenticated" } }))).toBe(
      "Switch account",
    );
  });
});

describe("describeSignInEvent", () => {
  const context = { providerName: "Codex", mode: "deviceCode" } as const;

  it("shows a starting state before the first event lands", () => {
    const presentation = describeSignInEvent(undefined, context);

    expect(presentation.phase).toBe("starting");
    expect(presentation.waiting).toBe(true);
  });

  it("surfaces the auth url for a browser handoff", () => {
    const presentation = describeSignInEvent(
      { _tag: "browserHandoff", authUrl: "https://auth.openai.com/oauth" },
      { providerName: "Codex", mode: "browser" },
    );

    expect(presentation.phase).toBe("browserHandoff");
    expect(presentation.authUrl).toBe("https://auth.openai.com/oauth");
    expect(presentation.waiting).toBe(true);
  });

  it("surfaces both the code and the verification url for a device code", () => {
    const presentation = describeSignInEvent(
      {
        _tag: "deviceCode",
        userCode: "ABCD-EFGHI",
        verificationUrl: "https://auth.openai.com/device",
      },
      context,
    );

    expect(presentation.phase).toBe("deviceCode");
    expect(presentation.userCode).toBe("ABCD-EFGHI");
    expect(presentation.verificationUrl).toBe("https://auth.openai.com/device");
  });

  it("stops waiting once the login is terminal", () => {
    expect(describeSignInEvent({ _tag: "completed" }, context).waiting).toBe(false);
    expect(describeSignInEvent({ _tag: "failed", message: "expired" }, context).waiting).toBe(
      false,
    );
  });

  it("renders the failure message verbatim and falls back when it is blank", () => {
    expect(describeSignInEvent({ _tag: "failed", message: "code expired" }, context).body).toBe(
      "code expired",
    );
    expect(describeSignInEvent({ _tag: "failed", message: "" }, context).body).toBe(
      "The sign-in did not complete.",
    );
  });
});

describe("signOutButtonLabel", () => {
  it("uses a two-step inline confirm", () => {
    expect(signOutButtonLabel(false)).toBe("Sign out");
    expect(signOutButtonLabel(true)).toBe("Confirm sign-out");
  });
});
