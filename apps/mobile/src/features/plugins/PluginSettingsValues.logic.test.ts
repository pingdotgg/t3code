import { pluginSettingRows } from "@t3tools/client-runtime/state/pluginSettings";
import {
  type PluginSettingField,
  PluginInstallationId,
  type PluginSettingsValues,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { describePluginSettingValue } from "./PluginSettingsValues.logic";

const fields: ReadonlyArray<PluginSettingField> = [
  { type: "number", key: "retries", label: "Retries", min: 0, max: 5, integer: true, default: 2 },
  {
    type: "select",
    key: "mode",
    label: "Mode",
    options: [
      { value: "safe", label: "Safe" },
      { value: "fast", label: "Fast" },
    ],
    default: "safe",
  },
  { type: "secret", key: "token", label: "Token" },
];
const shown = (saved: PluginSettingsValues["values"], secrets: ReadonlyArray<string> = []) =>
  pluginSettingRows(fields, {
    installationId: PluginInstallationId.make("installation-1"),
    values: saved,
    secrets,
  }).map(describePluginSettingValue);

describe("describePluginSettingValue", () => {
  it("marks defaults when nothing is saved", () => {
    expect(shown([])).toEqual(["2 (default)", "Safe (default)", "Not set"]);
  });

  it("shows saved values that still fit without a default label", () => {
    expect(
      shown(
        [
          { key: "retries", value: 4 },
          { key: "mode", value: "fast" },
        ],
        ["token"],
      ),
    ).toEqual(["4", "Fast", "Saved"]);
  });

  it("marks the default a saved value fell back to once it no longer fits", () => {
    // Saved before an update narrowed the range and removed the option.
    expect(
      shown([
        { key: "retries", value: 9 },
        { key: "mode", value: "turbo" },
      ]),
    ).toEqual(["2 (default)", "Safe (default)", "Not set"]);
  });
});
