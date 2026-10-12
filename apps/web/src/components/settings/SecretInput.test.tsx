import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { SecretInput } from "./SecretInput";

vi.mock("../ui/input", () => ({
  Input: (props: Record<string, unknown>) => <input {...props} />,
}));

let renderer: ReactTestRenderer;

beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(async () => {
  await act(() => renderer?.unmount());
  vi.unstubAllGlobals();
});

async function edit(value: string) {
  await act(() => renderer.root.findByType("input").props.onFocus());
  await act(() => renderer.root.findByType("input").props.onChange({ target: { value } }));
  await act(() => renderer.root.findByType("input").props.onBlur());
}

describe("SecretInput", () => {
  it("preserves a configured secret on empty edits and commits a replacement", async () => {
    const onCommit = vi.fn();
    await act(() => {
      renderer = create(<SecretInput configured value="" onCommit={onCommit} />);
    });
    await edit("");
    expect(onCommit).not.toHaveBeenCalled();
    await edit("replacement");
    expect(onCommit).toHaveBeenCalledExactlyOnceWith("replacement");
    expect(renderer.root.findByType("input").props.value).toBe("");
  });

  it("allows clearing an unsaved draft", async () => {
    const onCommit = vi.fn();
    await act(() => {
      renderer = create(<SecretInput value="draft" onCommit={onCommit} />);
    });
    await edit("");
    expect(onCommit).toHaveBeenCalledExactlyOnceWith("");
  });

  it("keeps an in-progress replacement when settings refresh", async () => {
    const onCommit = vi.fn();
    await act(() => {
      renderer = create(<SecretInput configured value="" onCommit={onCommit} />);
    });
    await act(() => renderer.root.findByType("input").props.onFocus());
    await act(() =>
      renderer.root.findByType("input").props.onChange({ target: { value: "replacement" } }),
    );
    await act(() => {
      renderer.update(<SecretInput configured value="" onCommit={onCommit} />);
    });
    expect(renderer.root.findByType("input").props.value).toBe("replacement");
    await act(() => renderer.root.findByType("input").props.onBlur());
    expect(onCommit).toHaveBeenCalledExactlyOnceWith("replacement");
  });
});
