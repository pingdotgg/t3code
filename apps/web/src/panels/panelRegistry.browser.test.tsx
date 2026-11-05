import { Suspense, useEffect, useState } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { render, act } from "../../test/render";
import { createPanelRegistry } from "./panelRegistry";

describe("panel registry", () => {
  it("does no work until opened and keeps one mount across lookups", async () => {
    let finish!: (value: { default: typeof Panel }) => void;
    const loaded = new Promise<{ default: typeof Panel }>((resolve) => {
      finish = resolve;
    });
    const mounted = vi.fn();
    const disposed = vi.fn();
    function Panel() {
      const [count, setCount] = useState(0);
      useEffect(() => {
        mounted();
        return disposed;
      }, []);
      return <button onClick={() => setCount((current) => current + 1)}>Count {count}</button>;
    }
    const load = vi.fn(() => loaded);
    const registry = createPanelRegistry([{ id: "diff", load }]);
    expect(load).not.toHaveBeenCalled();
    const Component = registry.get("diff")!.Component;
    await using screen = await render(
      <Suspense fallback={null}>
        <Component />
      </Suspense>,
    );
    expect(load).toHaveBeenCalledTimes(1);
    expect(mounted).not.toHaveBeenCalled();
    await act(async () => {
      finish({ default: Panel });
      await loaded;
    });
    await expect.element(screen.getByRole("button")).toHaveTextContent("Count 0");
    expect(mounted).toHaveBeenCalledTimes(1);
    await screen.getByRole("button").click();
    await expect.element(screen.getByRole("button")).toHaveTextContent("Count 1");
    const Again = registry.get("diff")!.Component;
    expect(Again).toBe(Component);
    await screen.rerender(
      <Suspense fallback={null}>
        <Again />
      </Suspense>,
    );
    expect(load).toHaveBeenCalledTimes(1);
    expect(mounted).toHaveBeenCalledTimes(1);
    expect(disposed).not.toHaveBeenCalled();
    await expect.element(screen.getByRole("button")).toHaveTextContent("Count 1");
    await screen.unmount();
    expect(disposed).toHaveBeenCalledTimes(1);
  });
});
