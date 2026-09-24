import { act, type ReactElement, useState } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { Switch } from "./switch";

let renderer: ReactTestRenderer | undefined;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

function ControlledSwitch({
  initialChecked,
  initialMixed = false,
}: {
  initialChecked: boolean;
  initialMixed?: boolean;
}) {
  const [checked, setChecked] = useState(initialChecked);
  const [mixed, setMixed] = useState(initialMixed);

  return (
    <Switch
      aria-label="Enable Claude Code"
      checked={checked}
      mixed={mixed}
      onCheckedChange={(nextChecked) => {
        setMixed(false);
        setChecked(nextChecked);
      }}
    />
  );
}

function switchRoot() {
  return renderer!.root.find((node) => node.type === "span" && node.props.role === "switch");
}

function hiddenInput() {
  return renderer!.root.find((node) => node.type === "input" && node.props.type === "checkbox");
}

async function clickSwitch() {
  await act(async () => {
    switchRoot().props.onClick({
      preventDefault() {},
      shiftKey: false,
      ctrlKey: false,
      altKey: false,
      metaKey: false,
    });
  });
}

async function renderSwitch(initialChecked: boolean, initialMixed = false) {
  const inputNode = {
    checked: initialChecked,
    ownerDocument: {
      defaultView: {
        PointerEvent: class PointerEvent {
          constructor(readonly type: string) {}
        },
      },
    },
    dispatchEvent() {
      const input = hiddenInput();
      input.props.onChange({
        nativeEvent: { defaultPrevented: false },
        currentTarget: { checked: !input.props.checked },
      });
    },
  };

  await act(async () => {
    renderer = create(<ControlledSwitch {...{ initialChecked, initialMixed }} />, {
      createNodeMock(element: ReactElement) {
        return element.type === "input" ? inputNode : {};
      },
    });
  });
}

describe("Switch accessibility", () => {
  it.each([
    { initialChecked: false, initialMixed: false, before: false, after: true },
    { initialChecked: true, initialMixed: false, before: true, after: false },
    { initialChecked: false, initialMixed: true, before: "mixed", after: true },
  ])("exposes $before before activation and $after after activation", async (state) => {
    await renderSwitch(state.initialChecked, state.initialMixed);
    expect(switchRoot().props["aria-checked"]).toBe(state.before);

    await clickSwitch();

    expect(switchRoot().props["aria-checked"]).toBe(state.after);
  });
});
