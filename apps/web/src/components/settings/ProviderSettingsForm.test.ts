import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind } from "@t3tools/contracts";

import { DRIVER_OPTION_BY_VALUE } from "./providerDriverMeta";
import {
  deriveProviderSettingsFields,
  nextProviderConfigWithFieldValue,
  readProviderConfigBoolean,
  readProviderConfigString,
} from "./ProviderSettingsForm";

describe("ProviderSettingsForm helpers", () => {
  it("derives visible provider config fields from the client definition schema", () => {
    const codex = DRIVER_OPTION_BY_VALUE[ProviderDriverKind.make("codex")];

    expect(codex).toBeDefined();
    expect(deriveProviderSettingsFields(codex!).map((field) => field.key)).toEqual([
      "binaryPath",
      "homePath",
      "shadowHomePath",
      "launchArgs",
    ]);
  });

  it("sources labels and descriptions from schema annotations", () => {
    const opencode = DRIVER_OPTION_BY_VALUE[ProviderDriverKind.make("opencode")];
    expect(opencode).toBeDefined();

    const serverPassword = deriveProviderSettingsFields(opencode!).find(
      (field) => field.key === "serverPassword",
    );

    expect(serverPassword).toMatchObject({
      label: "Server password",
      description: "Stored in plain text on disk.",
      control: "password",
    });
  });

  it("uses a dedicated environment field instead of legacy Cursor CLI settings", () => {
    const cursor = DRIVER_OPTION_BY_VALUE[ProviderDriverKind.make("cursor")];

    expect(cursor).toBeDefined();
    expect(deriveProviderSettingsFields(cursor!)).toEqual([]);
    expect(cursor?.environmentFields).toEqual([
      {
        name: "CURSOR_API_KEY",
        label: "Cursor API key",
        description: "Required by the Cursor Agent SDK.",
        placeholder: "Paste API key",
        sensitive: true,
      },
    ]);
  });

  it("exposes ACP Registry as an instance-only configurable driver", () => {
    const acpRegistry = DRIVER_OPTION_BY_VALUE[ProviderDriverKind.make("acpRegistry")];

    expect(acpRegistry).toBeDefined();
    expect(acpRegistry?.hasDefaultInstance).toBe(false);
    expect(deriveProviderSettingsFields(acpRegistry!).map((field) => field.key)).toEqual([
      "agentId",
      "commandPath",
      "authMethodId",
    ]);
  });

  it("exposes Hermes in Code as a distinct instance-only ACP driver", () => {
    const hermesAcp = DRIVER_OPTION_BY_VALUE[ProviderDriverKind.make("hermesAcp")];

    expect(hermesAcp).toBeDefined();
    expect(hermesAcp?.label).toBe("Hermes in Code");
    expect(hermesAcp?.hasDefaultInstance).toBe(false);
    expect(deriveProviderSettingsFields(hermesAcp!).map((field) => field.key)).toEqual([
      "binaryPath",
    ]);
    expect(hermesAcp?.environmentFields).toBeUndefined();
  });

  it("exposes Hermes as a built-in provider with its required settings and secret", () => {
    const hermes = DRIVER_OPTION_BY_VALUE[ProviderDriverKind.make("hermes")];

    expect(hermes).toBeDefined();
    expect(hermes?.hasDefaultInstance).not.toBe(false);
    expect(hermes?.defaultInstance).toEqual({
      driver: ProviderDriverKind.make("hermes"),
      enabled: false,
      config: {
        endpoint: "",
        remoteAccessEnabled: false,
        profileKey: "default",
        managedServerEnabled: true,
        customModels: [],
        importEnabled: false,
        mcpEnabled: true,
        attachmentsEnabled: true,
        proactiveEnabled: false,
        voiceEnabled: false,
      },
    });
    expect(deriveProviderSettingsFields(hermes!).map((field) => field.key)).toEqual([
      "endpoint",
      "profileKey",
      "managedServerEnabled",
      "remoteAccessEnabled",
      "importEnabled",
      "mcpEnabled",
      "attachmentsEnabled",
      "proactiveEnabled",
      "voiceEnabled",
    ]);
    expect(hermes?.environmentFields).toEqual([
      {
        name: "HERMES_GATEWAY_TOKEN",
        label: "Hermes gateway token",
        description:
          "Shared only with the attached gateway or a Hermes Serve process launched by T3.",
        placeholder: "Paste gateway token",
        sensitive: true,
      },
    ]);
  });

  it("exposes OpenClaw as a disabled-by-default ACP provider", () => {
    const openClaw = DRIVER_OPTION_BY_VALUE[ProviderDriverKind.make("openclaw")];

    expect(openClaw).toBeDefined();
    expect(openClaw?.label).toBe("OpenClaw");
    expect(openClaw?.badgeLabel).toBe("ACP");
    expect(openClaw?.defaultInstance).toEqual({
      driver: ProviderDriverKind.make("openclaw"),
      enabled: false,
      config: {
        binaryPath: "openclaw",
        url: "",
        tokenFile: "",
        passwordFile: "",
        session: "",
        resetSession: false,
        customModels: [],
      },
    });
    expect(deriveProviderSettingsFields(openClaw!).map((field) => field.key)).toEqual([
      "binaryPath",
      "url",
      "tokenFile",
      "passwordFile",
      "session",
      "resetSession",
    ]);
  });

  it("preserves unknown config keys while omitting empty configurable fields", () => {
    const opencode = DRIVER_OPTION_BY_VALUE[ProviderDriverKind.make("opencode")];
    expect(opencode).toBeDefined();

    const serverUrl = deriveProviderSettingsFields(opencode!).find(
      (field) => field.key === "serverUrl",
    );
    expect(serverUrl).toBeDefined();

    const next = nextProviderConfigWithFieldValue(
      { forkOwned: 1, serverUrl: "http://127.0.0.1:4096" },
      serverUrl!,
      "",
    );

    expect(next).toEqual({ forkOwned: 1 });
  });

  it("reads non-string config values as blank strings", () => {
    expect(readProviderConfigString({ binaryPath: 123 }, "binaryPath")).toBe("");
  });

  it("omits false boolean fields when clearWhenEmpty is omit", () => {
    const next = nextProviderConfigWithFieldValue(
      { forkOwned: 1, experimental: true },
      {
        key: "experimental",
        control: "switch",
        label: "Experimental",
        clearWhenEmpty: "omit",
        defaultBooleanValue: false,
      },
      false,
    );

    expect(next).toEqual({ forkOwned: 1 });
  });

  it("omits true boolean fields when true is the default", () => {
    const next = nextProviderConfigWithFieldValue(
      { forkOwned: 1, experimental: false },
      {
        key: "experimental",
        control: "switch",
        label: "Experimental",
        clearWhenEmpty: "omit",
        defaultBooleanValue: true,
      },
      true,
    );

    expect(next).toEqual({ forkOwned: 1 });
  });

  it("stores false boolean fields when true is the default", () => {
    const next = nextProviderConfigWithFieldValue(
      undefined,
      {
        key: "experimental",
        control: "switch",
        label: "Experimental",
        clearWhenEmpty: "omit",
        defaultBooleanValue: true,
      },
      false,
    );

    expect(next).toEqual({ experimental: false });
  });

  it("preserves false boolean fields when clearWhenEmpty is persist", () => {
    const next = nextProviderConfigWithFieldValue(
      undefined,
      {
        key: "experimental",
        control: "switch",
        label: "Experimental",
        clearWhenEmpty: "persist",
      },
      false,
    );

    expect(next).toEqual({ experimental: false });
  });

  it("reads non-boolean config values as false booleans", () => {
    expect(readProviderConfigBoolean({ experimental: "true" }, "experimental")).toBe(false);
  });

  it("reads missing boolean config values from the supplied default", () => {
    expect(readProviderConfigBoolean({}, "experimental", true)).toBe(true);
  });
});
