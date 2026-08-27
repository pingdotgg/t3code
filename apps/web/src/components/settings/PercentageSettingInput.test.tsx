import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { visitElements } from "../../test/reactElementTree";
import { NumberField, NumberFieldInput } from "../ui/number-field";
import { PercentageSettingInput } from "./PercentageSettingInput";

describe("PercentageSettingInput", () => {
  it("commits bounded integers through the shared number field", () => {
    const onCommit = vi.fn();
    const control = PercentageSettingInput({
      ariaLabel: "Contrast percentage",
      min: 50,
      max: 200,
      onCommit,
      value: 100,
    }) as ReactElement<Record<string, unknown>>;
    const field = visitElements(control, (element) => element.type === NumberField);
    const input = visitElements(control, (element) => element.type === NumberFieldInput);
    const commit = field?.props.onValueCommitted as ((value: number | null) => void) | undefined;

    commit?.(135);
    commit?.(250);
    commit?.(25);
    commit?.(null);

    expect(field?.props).toMatchObject({
      format: {
        maximumFractionDigits: 0,
        style: "unit",
        unit: "percent",
        useGrouping: false,
      },
      max: 200,
      min: 50,
      step: 1,
      value: 100,
    });
    expect(input?.props["aria-label"]).toBe("Contrast percentage");
    expect(onCommit.mock.calls).toEqual([[135], [200], [50]]);
  });
});
