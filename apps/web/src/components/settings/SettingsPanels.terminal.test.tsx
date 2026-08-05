import type { ComponentProps, ReactElement } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { DraftInput } from "../ui/draft-input";
import { DefaultTerminalShellSettingRow } from "./SettingsPanels";
import { SettingResetButton, SettingsRow } from "./settingsLayout";

function renderRow(value: string, environmentOs?: "darwin" | "linux" | "windows" | "unknown") {
  const onChange = vi.fn();
  const row = DefaultTerminalShellSettingRow({ value, environmentOs, onChange }) as ReactElement<
    ComponentProps<typeof SettingsRow>
  >;
  return { onChange, row };
}

describe("DefaultTerminalShellSettingRow", () => {
  it("commits a shell through the accessible input", () => {
    const { onChange, row } = renderRow("", "windows");
    const input = row.props.control as ReactElement<ComponentProps<typeof DraftInput>>;

    expect(row.props.title).toBe("Default terminal shell");
    expect(input.props["aria-label"]).toBe("Default terminal shell");
    expect(input.props.placeholder).toBe("pwsh.exe");

    input.props.onCommit("C:\\Program Files\\Git\\bin\\bash.exe");
    expect(onChange).toHaveBeenCalledWith("C:\\Program Files\\Git\\bin\\bash.exe");
  });

  it("only offers reset for a non-default value", () => {
    expect(renderRow("").row.props.resetAction).toBeNull();

    const { onChange, row } = renderRow("zsh");
    const reset = row.props.resetAction as ReactElement<ComponentProps<typeof SettingResetButton>>;
    expect(reset.props.label).toBe("default terminal shell");

    reset.props.onClick();
    expect(onChange).toHaveBeenCalledWith("");
  });

  it("stays neutral when the connected environment platform is unknown", () => {
    const input = renderRow("").row.props.control as ReactElement<
      ComponentProps<typeof DraftInput>
    >;
    expect(input.props.placeholder).toBe("Platform default");
  });
});
