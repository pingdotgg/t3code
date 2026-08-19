import { describe, expect, it, vi } from "vite-plus/test";
import { isValidElement } from "react";
import { ProviderDriverKind } from "@t3tools/contracts";

import { reactHookHarness } from "../../test/reactHookHarness";
import { visitElements } from "../../test/reactElementTree";
import { Select, SelectTrigger, SelectValue } from "../ui/select";
import { DRIVER_OPTION_BY_VALUE } from "./providerDriverMeta";
import {
  deriveProviderSettingsFields,
  nextProviderConfigWithFieldValue,
  ProviderSettingsFieldRow,
  readProviderConfigBoolean,
  readProviderConfigString,
} from "./ProviderSettingsForm";

vi.mock("react/compiler-runtime", async () => {
  return { c: reactHookHarness.useMemoCache };
});

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

  it("derives Devin settings fields in the configured order", () => {
    const devin = DRIVER_OPTION_BY_VALUE[ProviderDriverKind.make("devin")];

    expect(devin).toBeDefined();
    expect(deriveProviderSettingsFields(devin!).map((field) => field.key)).toEqual([
      "binaryPath",
      "homePath",
      "configPath",
      "agentType",
      "permissionMode",
      "sandbox",
      "respectWorkspaceTrust",
      "launchArgs",
    ]);

    const fields = deriveProviderSettingsFields(devin!);
    const permissionMode = fields.find((field) => field.key === "permissionMode");
    expect(permissionMode).toMatchObject({
      control: "select",
      options: [
        { value: "normal", label: "Normal" },
        { value: "accept-edits", label: "Accept edits" },
        { value: "smart", label: "Smart" },
        { value: "dangerous", label: "Dangerous" },
        { value: "autonomous", label: "Autonomous" },
      ],
    });
    expect(fields.find((field) => field.key === "agentType")).toMatchObject({
      control: "select",
      defaultValue: "default",
      options: [
        { value: "default", label: "Default coding agent" },
        { value: "review", label: "Review (read-only)" },
        { value: "summarizer", label: "Summarizer (no tools)" },
      ],
    });
    expect(fields.find((field) => field.key === "sandbox")).toMatchObject({
      control: "switch",
      defaultBooleanValue: false,
    });
    expect(fields.find((field) => field.key === "respectWorkspaceTrust")).toMatchObject({
      control: "switch",
      defaultBooleanValue: true,
    });
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

  it("omits string fields when the value equals the schema default", () => {
    const next = nextProviderConfigWithFieldValue(
      undefined,
      {
        key: "permissionMode",
        control: "select",
        label: "Permission mode",
        clearWhenEmpty: "omit",
        defaultValue: "normal",
      },
      "normal",
    );

    expect(next).toBeUndefined();
  });

  it("sources string default values from the schema", () => {
    const devin = DRIVER_OPTION_BY_VALUE[ProviderDriverKind.make("devin")];
    expect(devin).toBeDefined();

    const permissionMode = deriveProviderSettingsFields(devin!).find(
      (field) => field.key === "permissionMode",
    );
    expect(permissionMode?.defaultValue).toBe("normal");
  });
});

function containsSelectTrigger(node: unknown, id: string): boolean {
  return (
    visitElements(node, (element) => element.type === SelectTrigger && element.props.id === id) !==
    null
  );
}

function hasLabelWrappingSelectTrigger(node: unknown, id: string): boolean {
  if (Array.isArray(node)) {
    return node.some((child) => hasLabelWrappingSelectTrigger(child, id));
  }
  if (!isValidElement<Record<string, unknown>>(node)) return false;
  if (typeof node.type === "string" && node.type === "label") {
    return containsSelectTrigger(node.props.children, id);
  }
  return hasLabelWrappingSelectTrigger(node.props.children, id);
}

describe("ProviderSettingsForm select field", () => {
  it("renders the trigger outside a label, with a direct aria-label and without redundant classes", () => {
    const inputId = "test-permissionMode";
    const field = {
      key: "permissionMode",
      control: "select",
      label: "Permission mode",
      description: "Permission mode passed to `devin`.",
      clearWhenEmpty: "omit",
      options: [
        { value: "normal", label: "Normal" },
        { value: "accept-edits", label: "Accept edits" },
      ],
    } as const;

    const tree = ProviderSettingsFieldRow({
      field,
      value: { permissionMode: "normal" },
      idPrefix: "test",
      variant: "dialog",
      onChange: () => {},
    });

    const trigger = visitElements(
      tree,
      (element) => element.type === SelectTrigger && element.props.id === inputId,
    );
    expect(trigger).not.toBeNull();
    expect(trigger!.props["aria-label"]).toBe("Permission mode");

    const className = String(trigger!.props.className ?? "");
    expect(className).not.toMatch(/\bw-full\b/);
    expect(className).not.toMatch(/\bbg-background\b/);
    expect(className).not.toMatch(/\bmt-1\.5\b/);

    expect(hasLabelWrappingSelectTrigger(tree, inputId)).toBe(false);
  });

  it("renders the schema default when the config omits the select field", () => {
    const field = {
      key: "permissionMode",
      control: "select",
      label: "Permission mode",
      description: "Permission mode passed to `devin`.",
      clearWhenEmpty: "omit",
      defaultValue: "normal",
      options: [
        { value: "normal", label: "Normal" },
        { value: "accept-edits", label: "Accept edits" },
      ],
    } as const;

    const tree = ProviderSettingsFieldRow({
      field,
      value: {},
      idPrefix: "test",
      variant: "dialog",
      onChange: () => {},
    });

    const select = visitElements(tree, (element) => element.type === Select);
    expect(select).not.toBeNull();
    expect(select!.props.value).toBe("normal");

    const value = visitElements(tree, (element) => element.type === SelectValue);
    expect(value).not.toBeNull();
    expect(value!.props.children).toBe("Normal");
  });
});
