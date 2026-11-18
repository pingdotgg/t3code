import type { ProviderAuthState, ProviderInstallState } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  settleAuthorizationPage,
  settleHandoffAuthorizationPage,
  settleProviderInstall,
} from "./CodexSetupSection.logic";

const install = (overrides: Partial<ProviderInstallState>) =>
  ({
    driver: "codex",
    operationId: "op-1",
    phase: "downloading",
    downloadedBytes: 0,
    totalBytes: null,
    version: "0.2.0",
    installedVersion: "0.1.0",
    canRemove: true,
    message: null,
    ...overrides,
  }) as ProviderInstallState;

const auth = (overrides: Partial<ProviderAuthState>) =>
  ({
    instanceId: "codex",
    phase: "starting",
    flowId: "flow-1",
    authorizationUrl: null,
    expiresAt: null,
    message: null,
    ...overrides,
  }) as ProviderAuthState;

describe("settleProviderInstall", () => {
  it("ignores the previous runtime while the update it started has not been pushed yet", () => {
    const started = install({ operationId: "op-2", phase: "downloading" });
    const previous = install({ operationId: "op-1", phase: "succeeded" });
    expect(settleProviderInstall(started, previous)).toBeUndefined();
    expect(settleProviderInstall(started, null)).toBeUndefined();
    expect(settleProviderInstall(started, { ...started, phase: "extracting" })).toBeUndefined();
  });

  it("settles on the started operation's terminal phase", () => {
    const started = install({ operationId: "op-2" });
    expect(
      settleProviderInstall(
        started,
        install({ operationId: "op-2", phase: "succeeded", installedVersion: "0.2.0" }),
      ),
    ).toBe(true);
    expect(settleProviderInstall(started, install({ operationId: "op-2", phase: "failed" }))).toBe(
      false,
    );
    expect(
      settleProviderInstall(started, install({ operationId: "op-2", phase: "cancelled" })),
    ).toBe(false);
  });

  it("settles immediately when start reused an existing runtime", () => {
    expect(settleProviderInstall(install({ operationId: null, phase: "succeeded" }), null)).toBe(
      true,
    );
    expect(
      settleProviderInstall(
        install({ operationId: null, phase: "idle", installedVersion: null }),
        null,
      ),
    ).toBe(false);
  });
});

describe("settleAuthorizationPage", () => {
  it("waits for its own flow to reach the browser step", () => {
    expect(settleAuthorizationPage(null, "flow-1")).toBeUndefined();
    expect(settleAuthorizationPage(auth({ phase: "starting" }), "flow-1")).toBeUndefined();
    expect(
      settleAuthorizationPage(auth({ phase: "waiting", authorizationUrl: "https://a" }), "flow-1"),
    ).toBe("https://a");
    expect(
      settleAuthorizationPage(
        auth({
          phase: "waiting",
          authorizationUrl: "https://a",
          interaction: {
            type: "browser",
            id: "interaction-1",
            url: "https://b",
            requiresConsent: false,
          } as ProviderAuthState["interaction"],
        }),
        "flow-1",
      ),
    ).toBe("https://b");
  });

  it("ignores a flow another client started", () => {
    expect(
      settleAuthorizationPage(
        auth({ flowId: "flow-2", phase: "waiting", authorizationUrl: "https://a" }),
        "flow-1",
      ),
    ).toBeUndefined();
  });

  it("gives up when its flow ends before a page is available", () => {
    expect(settleAuthorizationPage(auth({ phase: "failed" }), "flow-1")).toBeNull();
    expect(settleAuthorizationPage(auth({ phase: "cancelled" }), "flow-1")).toBeNull();
    expect(settleAuthorizationPage(auth({ phase: "succeeded" }), "flow-1")).toBeNull();
  });

  it("follows a handoff until the primary environment finishes", () => {
    expect(
      settleHandoffAuthorizationPage({
        phase: "auth",
        state: auth({ flowId: "primary-flow", phase: "waiting", authorizationUrl: "https://a" }),
      }),
    ).toBe("https://a");
    expect(settleHandoffAuthorizationPage({ phase: "finished", profile: {} as never })).toBeNull();
  });
});
