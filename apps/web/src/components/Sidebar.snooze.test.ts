import { EnvironmentId } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("../rpc/atomRegistry", () => ({ appAtomRegistry: { get: () => undefined } }));
vi.mock("../state/server", () => ({ serverEnvironment: { settingsValueAtom: () => undefined } }));
vi.mock("./ui/toast", () => ({ toastManager: { add: vi.fn() } }));
vi.mock("../timestampFormat", () => ({
  formatShortTimestamp: (iso: string) => iso,
}));

import { i18n } from "../i18nCore";
import { resolveSnoozePresets } from "./Sidebar.snooze";

const environmentId = EnvironmentId.make("primary");
const now = new Date("2026-01-05T10:00:00");

describe("resolveSnoozePresets label localization", () => {
  afterEach(() => {
    void i18n.changeLanguage("en");
  });

  it("localizes preset labels in English", () => {
    const presets = resolveSnoozePresets(now, "24-hour", environmentId);
    expect(presets.find((preset) => preset.id === "after:180")?.label).toBe("In 3 hours");
  });

  it("relabels presets when the locale changes", () => {
    void i18n.changeLanguage("zh-Hans");
    const presets = resolveSnoozePresets(now, "24-hour", environmentId);
    expect(presets.find((preset) => preset.id === "after:180")?.label).toBe("过 3 小时");
    expect(presets.find((preset) => preset.id === "at:tomorrow:09:00")?.label).toBe("明天");
  });
});
