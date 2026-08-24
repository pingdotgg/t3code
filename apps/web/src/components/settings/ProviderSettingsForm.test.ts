import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind } from "@t3tools/contracts";
import { createTranslator } from "../../i18n";

import { DRIVER_OPTION_BY_VALUE } from "./providerDriverMeta";
import {
  deriveProviderSettingsFields,
  localizeProviderSettingsFields,
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

  it("registers localized Pi binary and home directory settings", () => {
    const pi = DRIVER_OPTION_BY_VALUE[ProviderDriverKind.make("piAgent")];
    expect(pi).toBeDefined();

    const fields = deriveProviderSettingsFields(pi!);
    expect(fields.map((field) => field.key)).toEqual(["binaryPath", "homePath"]);
    expect(localizeProviderSettingsFields(pi!, fields, createTranslator("en"))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "binaryPath", label: "Binary path" }),
        expect.objectContaining({ key: "homePath", label: "Pi agent home path" }),
      ]),
    );
    expect(localizeProviderSettingsFields(pi!, fields, createTranslator("zh-CN"))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "binaryPath", label: "可执行文件路径" }),
        expect.objectContaining({ key: "homePath", label: "Pi Agent 主目录" }),
      ]),
    );
  });

  it("registers localized Oh My Pi settings independently", () => {
    const omp = DRIVER_OPTION_BY_VALUE[ProviderDriverKind.make("omp")];
    expect(omp).toBeDefined();

    const fields = deriveProviderSettingsFields(omp!);
    expect(fields.map((field) => field.key)).toEqual(["binaryPath", "homePath"]);
    expect(localizeProviderSettingsFields(omp!, fields, createTranslator("en"))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "binaryPath", label: "Binary path" }),
        expect.objectContaining({ key: "homePath", label: "Oh My Pi home path" }),
      ]),
    );
    expect(localizeProviderSettingsFields(omp!, fields, createTranslator("zh-CN"))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "binaryPath", label: "可执行文件路径" }),
        expect.objectContaining({ key: "homePath", label: "Oh My Pi 主目录" }),
      ]),
    );
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
