import { act, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vite-plus/test";

import { useKeySet } from "./useKeySet";

it("preserves embedded newlines without changing identity for reordered keys", async () => {
  const seen: ReadonlySet<string>[] = [];
  function Probe({ keys }: { readonly keys: ReadonlyArray<string> }) {
    const value = useKeySet(keys);
    useLayoutEffect(() => {
      seen.push(value);
    });
    return null;
  }
  const root = createRoot(document.createElement("div"));
  try {
    await act(async () => root.render(<Probe keys={["a\nb", "c"]} />));
    expect(seen.at(-1)).toEqual(new Set(["a\nb", "c"]));
    const original = seen.at(-1);
    await act(async () => root.render(<Probe keys={["c", "a\nb"]} />));
    expect(seen.at(-1)).toBe(original);
    await act(async () => root.render(<Probe keys={["a", "b", "c"]} />));
    expect(seen.at(-1)).toEqual(new Set(["a", "b", "c"]));
    expect(seen.at(-1)).not.toBe(original);
    await act(async () => root.render(<Probe keys={[]} />));
    expect(seen.at(-1)?.size).toBe(0);
  } finally {
    act(() => root.unmount());
  }
});
