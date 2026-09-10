import { act } from "react";
import { LayersIcon } from "lucide-react";
import { create } from "react-test-renderer";
import { expect, it, vi } from "vite-plus/test";

import { visitElements } from "../../test/reactElementTree";
import { MenuRadioGroup } from "../ui/menu";
import { CompactFilterMenu, useListSearchShortcut } from "./ListTitlebarControls";

it("does not reset the list scope when the current provider is selected again", () => {
  const onChange = vi.fn();
  const menu = CompactFilterMenu({
    label: "Filter by provider",
    value: "github.com",
    options: [{ value: "github.com", label: "GitHub", Icon: LayersIcon }],
    onChange,
  });
  const group = visitElements(menu, (element) => element.type === MenuRadioGroup);
  const select = group?.props.onValueChange as (value: string) => void;

  select("github.com");
  expect(onChange).not.toHaveBeenCalled();
  select("");
  expect(onChange).toHaveBeenCalledExactlyOnceWith("");
});

it("leaves find in an editor alone but focuses the list from elsewhere", async () => {
  const events = new EventTarget();
  const focus = vi.fn();
  const select = vi.fn();
  const container = {
    querySelector: () => ({ focus, select }),
    contains: () => false,
  } as unknown as HTMLDivElement;
  class Editable {
    isContentEditable = true;
  }
  vi.stubGlobal("window", events);
  vi.stubGlobal("HTMLElement", Editable);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  function Probe({ active = true }: { active?: boolean }) {
    useListSearchShortcut({
      active,
      condensed: false,
      inFlowSearchRef: { current: container },
      setSearchOpen: vi.fn(),
      setSearchFocusToken: vi.fn(),
    });
    return null;
  }
  let renderer: ReturnType<typeof create>;
  try {
    await act(() => {
      renderer = create(<Probe />);
    });
    const editorFind = new Event("keydown", { cancelable: true });
    Object.defineProperties(editorFind, {
      key: { value: "f" },
      ctrlKey: { value: true },
      target: { value: new Editable() },
    });
    events.dispatchEvent(editorFind);
    expect(editorFind.defaultPrevented).toBe(false);
    expect(focus).not.toHaveBeenCalled();

    const listFind = new Event("keydown", { cancelable: true });
    Object.defineProperties(listFind, { key: { value: "f" }, ctrlKey: { value: true } });
    events.dispatchEvent(listFind);
    expect(listFind.defaultPrevented).toBe(true);
    expect(focus).toHaveBeenCalledOnce();
    expect(select).toHaveBeenCalledOnce();

    await act(() => renderer.update(<Probe active={false} />));
    const detailFind = new Event("keydown", { cancelable: true });
    Object.defineProperties(detailFind, { key: { value: "f" }, ctrlKey: { value: true } });
    events.dispatchEvent(detailFind);
    expect(detailFind.defaultPrevented).toBe(false);
    expect(focus).toHaveBeenCalledOnce();
  } finally {
    await act(() => renderer?.unmount());
    vi.unstubAllGlobals();
  }
});
