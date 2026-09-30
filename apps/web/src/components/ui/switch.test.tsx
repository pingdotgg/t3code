// @vitest-environment jsdom

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { Switch } from "./switch";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
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
  const element = container.querySelector<HTMLElement>('[role="switch"]');
  if (!element) throw new Error("Switch was not rendered");
  return element;
}

async function clickSwitch() {
  await act(async () => switchRoot().click());
}

async function renderSwitch(initialChecked: boolean, initialMixed = false) {
  await act(async () => {
    root.render(<ControlledSwitch {...{ initialChecked, initialMixed }} />);
  });
}

describe("Switch accessibility", () => {
  it.each([
    { initialChecked: false, initialMixed: false, before: false, after: true },
    { initialChecked: true, initialMixed: false, before: true, after: false },
    { initialChecked: false, initialMixed: true, before: "mixed", after: true },
  ])("exposes $before before activation and $after after activation", async (state) => {
    await renderSwitch(state.initialChecked, state.initialMixed);
    expect(switchRoot().getAttribute("aria-checked")).toBe(String(state.before));

    await clickSwitch();

    expect(switchRoot().getAttribute("aria-checked")).toBe(String(state.after));
    expect(container.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(
      state.after,
    );
  });
});
