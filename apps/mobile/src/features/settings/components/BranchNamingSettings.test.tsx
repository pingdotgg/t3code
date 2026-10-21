import type { BranchNamingMode } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

type InputProps = {
  accessibilityLabel: string;
  defaultValue: string;
  onChangeText: (text: string) => void;
  onEndEditing: (event: { nativeEvent: { text: string } }) => void;
};

const inputs = vi.hoisted(() => new Map<string, InputProps>());

vi.mock("react-native", () => ({
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../../../components/ui/AppText", () => ({
  AppText: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  AppTextInput: (props: InputProps) => {
    inputs.set(props.accessibilityLabel, props);
    return null;
  },
}));
vi.mock("./SettingsChoiceRow", () => ({ SettingsChoiceRow: () => null }));
vi.mock("./SettingsSection", () => ({
  SettingsSection: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

import { BranchNamingSettings } from "./BranchNamingSettings";

const PREFIX = "Branch prefix";
const INSTRUCTIONS = "Branch naming instructions";

let root: Root;
const onChange = vi.fn();

function render(
  mode: BranchNamingMode,
  saved: { prefix?: string; instructions?: string } = {},
  disabled = false,
) {
  act(() =>
    root.render(
      <BranchNamingSettings
        mode={mode}
        prefix={saved.prefix ?? "t3"}
        instructions={saved.instructions ?? "Use issue IDs."}
        disabled={disabled}
        onChange={onChange}
      />,
    ),
  );
}

// Android Back hides the keyboard without ending editing; leaving then only unmounts.
function leaveScreen() {
  act(() => root.unmount());
  root = createRoot(document.createElement("div"));
}

function input(label: string) {
  const props = inputs.get(label);
  if (!props) throw new Error(`${label} input not rendered`);
  return props;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  root = createRoot(document.createElement("div"));
  inputs.clear();
  onChange.mockClear();
});

afterEach(() => {
  act(() => root.unmount());
});

describe("BranchNamingSettings", () => {
  it("saves typed instructions when the screen closes before editing ends", () => {
    render("custom");
    act(() => input(INSTRUCTIONS).onChangeText("  Use julius/ prefixes.  "));
    leaveScreen();

    expect(onChange).toHaveBeenCalledExactlyOnceWith({
      branchNameInstructions: "Use julius/ prefixes.",
    });
  });

  // regression: #18381 branch naming text saves when you leave the screen
  it("saves both drafts in one patch when the screen closes", () => {
    render("static");
    act(() => input(PREFIX).onChangeText("feat/"));
    render("custom");
    act(() => input(INSTRUCTIONS).onChangeText("New rules."));
    leaveScreen();

    expect(onChange).toHaveBeenCalledExactlyOnceWith({
      branchNamePrefix: "feat/",
      branchNameInstructions: "New rules.",
    });
  });

  it("still saves a draft when a pending write disables the field", () => {
    render("custom");
    act(() => input(INSTRUCTIONS).onChangeText("New rules."));
    render("custom", {}, true);
    leaveScreen();

    expect(onChange).toHaveBeenCalledExactlyOnceWith({ branchNameInstructions: "New rules." });
  });

  it("drops a draft once a newer saved value replaces the field", () => {
    render("custom");
    act(() => input(INSTRUCTIONS).onChangeText("Old draft."));
    render("custom", { instructions: "Saved elsewhere." });
    leaveScreen();

    expect(onChange).not.toHaveBeenCalled();
  });
});
