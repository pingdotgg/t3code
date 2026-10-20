import { act, render } from "../../../test/render";
import { useState } from "react";
import { describe, expect, it } from "vite-plus/test";

import { Switch } from "./switch";

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

describe("Switch accessibility", () => {
  it.each([
    { initialChecked: false, initialMixed: false, before: false, after: true },
    { initialChecked: true, initialMixed: false, before: true, after: false },
    { initialChecked: false, initialMixed: true, before: "mixed", after: true },
  ])("exposes $before before activation and $after after activation", async (state) => {
    await using screen = await render(
      <ControlledSwitch initialChecked={state.initialChecked} initialMixed={state.initialMixed} />,
    );
    const { container } = screen;
    const switchRoot = () => container.querySelector<HTMLElement>('[role="switch"]')!;
    expect(switchRoot().getAttribute("aria-checked")).toBe(String(state.before));

    await act(() => switchRoot().click());

    expect(switchRoot().getAttribute("aria-checked")).toBe(String(state.after));
    expect(container.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(
      state.after,
    );
  });
});
