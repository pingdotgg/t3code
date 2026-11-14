import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { EnvironmentId } from "@t3tools/contracts";

const { Children, fields } = vi.hoisted(() => {
  (globalThis as { __DEV__?: boolean }).__DEV__ = false;
  return {
    Children: ({ children }: { children?: ReactNode }) => <>{children}</>,
    fields: new Map<string, { value: string; onChangeText: (text: string) => void }>(),
  };
});

vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  View: Children,
  Pressable: ({ children, onPress }: { children?: ReactNode; onPress?: () => void }) => (
    <button type="button" onClick={onPress}>
      {children}
    </button>
  ),
}));
vi.mock("react-native-reanimated", () => {
  const transition = { duration: () => transition };
  return {
    default: { View: Children },
    FadeIn: transition,
    FadeOut: transition,
    LinearTransition: transition,
  };
});
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => null }));
vi.mock("@t3tools/client-runtime/connection", () => ({
  hasSavedBearerRoute: () => true,
  hostFreezeNotice: () => null,
}));
vi.mock("../../components/ui/Dialog", () => ({ alert: vi.fn() }));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../../components/EnvironmentMachineSymbol", () => ({
  EnvironmentMachineSymbol: () => null,
}));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/ui/Button", () => ({ Button: () => null }));
vi.mock("../../components/ui/IconButton", () => ({ IconButton: () => null }));
vi.mock("../../components/ui/ThemedSwitch", () => ({ ThemedSwitch: () => null }));
vi.mock("../../state/server", () => ({ serverEnvironment: { configValueAtom: () => ({}) } }));
vi.mock("../../state/presentation", () => ({
  environmentPresentations: { presentationAtom: () => ({}) },
}));
vi.mock("./ConnectionDiagnosisDetails", () => ({
  ConnectionDiagnosisDetails: () => null,
  useConnectionDiagnosis: () => ({ diagnosis: null, state: null }),
}));
vi.mock("./ConnectionTraceId", () => ({ ConnectionTraceId: () => null }));
vi.mock("./ConnectionStatusDot", () => ({ ConnectionStatusDot: () => null }));
vi.mock("./environmentStatusText", () => ({ environmentStatusText: () => null }));
vi.mock("./ConnectionFormField", () => ({
  ConnectionFormField: (props: {
    label: string;
    value: string;
    onChangeText: (text: string) => void;
  }) => {
    fields.set(props.label, props);
    return null;
  },
}));

import { ConnectionEnvironmentRow } from "./ConnectionEnvironmentRow";

it("Conn: every opening of the form starts from the current name and remembers it", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const onUpdate = vi.fn(async () => AsyncResult.success(undefined));
  const container = document.createElement("div");
  const root = createRoot(container);
  const render = (environmentLabel: string, expanded: boolean) =>
    act(() =>
      root.render(
        <ConnectionEnvironmentRow
          environment={{
            environmentId: EnvironmentId.make("environment-row"),
            environmentLabel,
            displayUrl: "http://box.example.test",
            isRelayManaged: false,
            isEnabled: true,
            connectionState: "connected",
            connectionError: null,
            connectionErrorTraceId: null,
          }}
          expanded={expanded}
          onToggle={() => {}}
          onReconnect={() => {}}
          onRemove={() => {}}
          onSetEnabled={() => {}}
          onUpdate={onUpdate}
        />,
      ),
    );
  const save = async (typed: string) => {
    act(() => fields.get("Label")!.onChangeText(typed));
    await act(async () =>
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "Save")!
        .click(),
    );
  };

  render("instance-1846", false);
  // The server renamed itself while the row stayed mounted.
  render("task-5003.dlf-leden", false);
  render("task-5003.dlf-leden", true);
  expect(fields.get("Label")!.value).toBe("task-5003.dlf-leden");
  await save("Mine");
  expect(onUpdate).toHaveBeenLastCalledWith(EnvironmentId.make("environment-row"), {
    label: "Mine",
    displayUrl: "http://box.example.test",
    openedLabel: "task-5003.dlf-leden",
  });

  // A second edit on the same mounted row: renaming back is an edit of the name it opened with.
  render("Mine", false);
  render("Mine", true);
  await save("task-5003.dlf-leden");
  expect(onUpdate).toHaveBeenLastCalledWith(EnvironmentId.make("environment-row"), {
    label: "task-5003.dlf-leden",
    displayUrl: "http://box.example.test",
    openedLabel: "Mine",
  });
  act(() => root.unmount());
});
