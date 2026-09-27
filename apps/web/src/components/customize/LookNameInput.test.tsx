import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { Input } from "../ui/input";
import { LookNameInput } from "./LookNameInput";

let renderer: ReactTestRenderer;
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(async () => {
  await act(() => renderer?.unmount());
  vi.unstubAllGlobals();
});

it("starts each rename with the selected look name, including after a selection change", async () => {
  const onRename = vi.fn();
  const onDone = vi.fn();
  await act(() => {
    renderer = create(
      <LookNameInput key="ocean" look={{ name: "Ocean" }} onRename={onRename} onDone={onDone} />,
    );
  });
  await act(() =>
    renderer.root.findByType(Input).props.onChange({ target: { value: "Old draft" } }),
  );
  await act(() =>
    renderer.update(
      <LookNameInput key="forest" look={{ name: "Forest" }} onRename={onRename} onDone={onDone} />,
    ),
  );
  expect(renderer.root.findByType(Input).props.value).toBe("Forest");
  await act(() => renderer.root.findByType(Input).props.onBlur());
  expect(onRename).not.toHaveBeenCalled();
  expect(onDone).toHaveBeenCalledOnce();

  await act(() => renderer.update(<></>));
  await act(() =>
    renderer.update(
      <LookNameInput
        key="forest"
        look={{ name: "New Forest" }}
        onRename={onRename}
        onDone={onDone}
      />,
    ),
  );
  expect(renderer.root.findByType(Input).props.value).toBe("New Forest");
  await act(() =>
    renderer.root.findByType(Input).props.onChange({ target: { value: "  Woods  " } }),
  );
  await act(() => renderer.root.findByType(Input).props.onBlur());
  expect(onRename).toHaveBeenCalledExactlyOnceWith("Woods");
});
