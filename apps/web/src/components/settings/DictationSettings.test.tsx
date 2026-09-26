import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type { DictationReplacement } from "@t3tools/contracts";
import { DictationSettings } from "./DictationSettings";

const state = vi.hoisted(() => ({
  replacements: [] as DictationReplacement[],
  update: vi.fn(),
}));
vi.mock("./useScopedSettings", () => ({
  useScopedSettings: () => ({
    autoPolish: false,
    spokenCommands: true,
    removeFillers: true,
    replacements: state.replacements,
  }),
  useUpdateScopedSettings: () => state.update,
}));
vi.mock("./SettingsScopeContext", () => ({
  useSettingsScope: () => ({
    scope: { kind: "environment" },
    connectedEnvironments: [{ environmentId: "test" }],
  }),
}));
vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("../ui/input", () => ({ Input: "input" }));
vi.mock("../ui/textarea", () => ({ Textarea: "textarea" }));
vi.mock("../ui/switch", () => ({ Switch: "mock-switch" }));
vi.mock("../ui/select", () => ({
  Select: "mock-select",
  SelectItem: "mock-item",
  SelectPopup: "mock-popup",
  SelectTrigger: "mock-trigger",
  SelectValue: "mock-value",
}));
vi.mock("./settingsLayout", () => ({ SettingsRow: "mock-row", SettingsSection: "section" }));

let renderer: ReactTestRenderer;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.replacements = [{ kind: "word", phrase: "tea three", replacement: "T3" }];
  state.update.mockReset();
  act(() => {
    renderer = create(<DictationSettings />);
  });
});
afterEach(() => {
  act(() => renderer.unmount());
  vi.unstubAllGlobals();
});
const click = (label: string) =>
  act(() => {
    renderer.root
      .findAllByType("button")
      .find((button) => button.props.children === label)!
      .props.onClick();
  });
const change = (label: string, value: string) =>
  act(() => {
    renderer.root.findByProps({ "aria-label": label }).props.onChange({ target: { value } });
  });

it.each(
  (
    [
      [{ kind: "word", phrase: "tea three", replacement: "Changed elsewhere" }],
      [{ kind: "snippet", phrase: "tea three", replacement: "T3" }],
      [{ kind: "word", phrase: "renamed", replacement: "T3" }],
      [],
    ] satisfies DictationReplacement[][]
  ).map((entries) => ({ entries })),
)("refuses to overwrite an entry changed on another client: %j", ({ entries }) => {
  click("Edit");
  change("Replacement text", "My local edit");
  state.replacements = entries;
  act(() => renderer.update(<DictationSettings />));
  click("Save changes");
  expect(state.update).not.toHaveBeenCalled();
  expect(renderer.root.findByProps({ role: "alert" }).props.children).toContain(
    "changed on another client",
  );
  click("Cancel");
  expect(renderer.root.findAllByProps({ role: "alert" })).toHaveLength(0);
});

it("saves an unchanged entry while preserving a new entry from another client", () => {
  click("Edit");
  change("Replacement text", "T3 Code");
  const added: DictationReplacement = { kind: "word", phrase: "wispr", replacement: "Wispr" };
  state.replacements = [...state.replacements, added];
  act(() => renderer.update(<DictationSettings />));
  click("Save changes");
  expect(state.update).toHaveBeenCalledWith({
    dictation: {
      replacements: [{ kind: "word", phrase: "tea three", replacement: "T3 Code" }, added],
    },
  });
});
