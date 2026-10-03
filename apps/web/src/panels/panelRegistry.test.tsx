import { act, Suspense, useEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vite-plus/test";

import { createPanelRegistry } from "./panelRegistry";

// These exercise lazy evaluation and actual mount/disposal, without inspecting markup.
describe("panel registry", () => {
  it("rejects duplicate ids without loading either panel", () => {
    const load = vi.fn();
    const definition = { id: "diff", title: "Diff", placement: "side-panel", load } as const;
    expect(() => createPanelRegistry([definition, definition])).toThrow("Duplicate panel id: diff");
    expect(load).not.toHaveBeenCalled();
  });

  it("does no work until opened and mounts synchronously after the chunk resolves", async () => {
    let finish!: (value: { default: typeof Panel }) => void;
    const loaded = new Promise<{ default: typeof Panel }>((resolve) => {
      finish = resolve;
    });
    const mounted = vi.fn();
    const disposed = vi.fn();
    function Panel() {
      useEffect(() => {
        mounted();
        return disposed;
      }, []);
      return null;
    }
    const load = vi.fn(() => loaded);
    const registry = createPanelRegistry([
      { id: "diff", title: "Diff", placement: "side-panel", load },
    ]);
    expect(load).not.toHaveBeenCalled();
    const Component = registry.get("diff")!.Component;
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <Suspense fallback={null}>
          <Component />
        </Suspense>,
      );
    });
    expect(load).toHaveBeenCalledTimes(1);
    expect(mounted).not.toHaveBeenCalled();
    await act(async () => {
      finish({ default: Panel });
      await loaded;
    });
    expect(mounted).toHaveBeenCalledTimes(1);
    await act(async () => {
      renderer.unmount();
    });
    expect(disposed).toHaveBeenCalledTimes(1);
  });
});
