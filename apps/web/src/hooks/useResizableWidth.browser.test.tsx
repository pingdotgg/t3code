import { describe, expect, it } from "vite-plus/test";

import { act, render } from "../../test/render";
import { useResizableWidth } from "./useResizableWidth";

const STORAGE_KEY = "test:responsive-panel-width";

function Panel({ defaultWidth }: { defaultWidth: number }) {
  const { width, setWidth } = useResizableWidth({
    storageKey: STORAGE_KEY,
    defaultWidth,
    minWidth: 160,
    maxWidth: 560,
    edge: "left",
  });
  return <button onClick={() => setWidth(350)}>{width}</button>;
}

describe("useResizableWidth", () => {
  it("follows a responsive default until the user saves a width", async () => {
    const previous = localStorage.getItem(STORAGE_KEY);
    localStorage.removeItem(STORAGE_KEY);
    try {
      // This hook only needs browser storage and React; no navigation is involved.
      await using screen = await render(<Panel defaultWidth={320} />, { router: false });
      expect(screen.container.textContent).toBe("320");
      await screen.rerender(<Panel defaultWidth={200} />);
      expect(screen.container.textContent).toBe("200");

      await act(() => screen.container.querySelector("button")!.click());
      await screen.rerender(<Panel defaultWidth={180} />);
      expect(screen.container.textContent).toBe("350");

      await screen.unmount();
      await using restored = await render(<Panel defaultWidth={200} />, { router: false });
      expect(restored.container.textContent).toBe("350");
    } finally {
      if (previous === null) localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, previous);
    }
  });
});
