import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("../ui/number-field", () => ({
  NumberField: "section",
  NumberFieldDecrement: "button",
  NumberFieldGroup: "div",
  NumberFieldIncrement: "button",
  NumberFieldInput: "input",
}));
import { DaysNumberField } from "./DaysNumberField";

let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  await act(async () => renderer?.unmount());
});

describe("day-count editing", () => {
  it("keeps typing local, restores empty input, and commits a bounded whole number", async () => {
    const commit = vi.fn();
    await act(async () => {
      renderer = create(
        <DaysNumberField value={8} min={1} max={90} label="Days" onCommit={commit} />,
      );
    });
    const field = () => renderer!.root.findByType("section");
    await act(async () => field().props.onValueChange(null));
    expect(commit).not.toHaveBeenCalled();
    await act(async () => field().props.onValueCommitted(null));
    expect(field().props.value).toBe(8);
    expect(commit).not.toHaveBeenCalled();
    await act(async () => field().props.onValueCommitted(3.5));
    expect(commit).toHaveBeenLastCalledWith(4);
    await act(async () => field().props.onValueCommitted(200));
    expect(commit).toHaveBeenLastCalledWith(90);
    await act(async () => field().props.onValueCommitted(0));
    expect(commit).toHaveBeenLastCalledWith(1);
  });

  it("replaces a local edit when the saved value changes externally", async () => {
    const commit = vi.fn();
    await act(async () => {
      renderer = create(
        <DaysNumberField value={8} min={1} max={3650} label="Days" onCommit={commit} />,
      );
    });
    await act(async () => renderer!.root.findByType("section").props.onValueChange(12));
    await act(async () =>
      renderer!.update(
        <DaysNumberField value={30} min={1} max={3650} label="Days" onCommit={commit} />,
      ),
    );
    expect(renderer!.root.findByType("section").props.value).toBe(30);
    expect(commit).not.toHaveBeenCalled();
  });
});
