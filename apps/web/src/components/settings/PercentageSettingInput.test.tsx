import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { visitElements } from "../../test/reactElementTree";
import { DraftInput } from "../ui/draft-input";
import { parsePercentageSettingValue, PercentageSettingInput } from "./PercentageSettingInput";

describe("PercentageSettingInput", () => {
  it.each([
    ["50", 50],
    ["125", 125],
    ["200", 200],
  ])("accepts an integer percentage within the supported range: %s", (draft, expected) => {
    expect(parsePercentageSettingValue(draft, 50, 200)).toBe(expected);
  });

  it.each(["", "49", "201", "72.5", "percent"])("rejects an invalid percentage: %s", (draft) => {
    expect(parsePercentageSettingValue(draft, 50, 200)).toBeNull();
  });

  it("commits valid input and ignores invalid input", () => {
    const onCommit = vi.fn();
    const control = PercentageSettingInput({
      ariaLabel: "Contrast percentage",
      min: 50,
      max: 200,
      onCommit,
      value: 100,
    }) as ReactElement<Record<string, unknown>>;
    const input = visitElements(control, (element) => element.type === DraftInput);
    const suffix = visitElements(
      control,
      (element) => element.type === "span" && element.props.children === "%",
    );
    const commit = input?.props.onCommit as ((draft: string) => void) | undefined;

    commit?.("135");
    commit?.("201");

    expect(input?.props).toMatchObject({
      "aria-label": "Contrast percentage",
      inputMode: "numeric",
      maxLength: 3,
      value: "100",
    });
    expect(suffix?.props["aria-hidden"]).toBe("true");
    expect(onCommit).toHaveBeenCalledOnce();
    expect(onCommit).toHaveBeenCalledWith(135);
  });
});
