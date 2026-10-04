import { act, Suspense, useEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vite-plus/test";

import { createPanelRegistry } from "./panelRegistry";

const metadata = {
  icon: () => null,
  launcherKey: "X",
  unavailableHint: "Unavailable.",
  unavailableReason: "Unavailable here.",
} as const;

// These exercise lazy evaluation and actual mount/disposal, without inspecting markup.
describe("panel registry", () => {
  it("rejects duplicate ids without loading either panel", () => {
    const load = vi.fn();
    const definition = { ...metadata, id: "diff", title: "Diff", load } as const;
    expect(() => createPanelRegistry([definition, definition])).toThrow("Duplicate panel id: diff");
    expect(load).not.toHaveBeenCalled();
  });

  it("does no work until opened and keeps one mount across lookups", async () => {
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
    const registry = createPanelRegistry([{ ...metadata, id: "diff", title: "Diff", load }]);
    expect(load).not.toHaveBeenCalled();
    const Component = registry.get("diff").Component;
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
    // A parent re-render looks the panel up again; it must keep the same mount and state.
    const Again = registry.get("diff").Component;
    expect(Again).toBe(Component);
    await act(async () => {
      renderer.update(
        <Suspense fallback={null}>
          <Again />
        </Suspense>,
      );
    });
    expect(load).toHaveBeenCalledTimes(1);
    expect(mounted).toHaveBeenCalledTimes(1);
    expect(disposed).not.toHaveBeenCalled();
    await act(async () => {
      renderer.unmount();
    });
    expect(disposed).toHaveBeenCalledTimes(1);
  });

  it("keeps heterogeneous panels independent and their lazy identities stable", async () => {
    const events: string[] = [];
    function Notes({ text }: { text: string }) {
      useEffect(() => {
        events.push(`mount notes:${text}`);
        return () => {
          events.push("dispose notes");
        };
      }, [text]);
      return null;
    }
    function Counter({ count }: { count: number }) {
      useEffect(() => {
        events.push(`mount counter:${count}`);
      }, [count]);
      return null;
    }
    const loadNotes = vi.fn(async () => ({ default: Notes }));
    const loadCounter = vi.fn(async () => ({ default: Counter }));
    const registry = createPanelRegistry([
      { ...metadata, id: "notes", title: "Notes", load: loadNotes },
      { ...metadata, id: "counter", title: "Counter", load: loadCounter },
    ]);
    const NotesPanel = registry.get("notes").Component;
    // Compile-only: the project typecheck rejects these pairings.
    const compileOnly = () => [
      // @ts-expect-error Missing required text.
      <NotesPanel key="missing" />,
      // @ts-expect-error Counter's props on Notes.
      <NotesPanel key="foreign" count={1} />,
      // @ts-expect-error Unknown id.
      registry.get("missing"),
    ];
    expect(compileOnly).toBeTypeOf("function");
    expect(registry.get("notes").Component).toBe(NotesPanel);
    expect(loadNotes).not.toHaveBeenCalled();
    expect(loadCounter).not.toHaveBeenCalled();

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <Suspense fallback={null}>
          <NotesPanel text="a" />
        </Suspense>,
      );
    });
    await act(async () => {
      renderer.update(
        <Suspense fallback={null}>
          <NotesPanel text="a" />
        </Suspense>,
      );
    });
    expect(loadNotes).toHaveBeenCalledTimes(1);
    expect(loadCounter).not.toHaveBeenCalled();
    expect(events).toEqual(["mount notes:a"]);

    const CounterPanel = registry.get("counter").Component;
    await act(async () => {
      renderer.update(
        <Suspense fallback={null}>
          <CounterPanel count={2} />
        </Suspense>,
      );
    });
    expect(loadCounter).toHaveBeenCalledTimes(1);
    expect(events).toEqual(["mount notes:a", "dispose notes", "mount counter:2"]);
    expect(registry.get("counter").Component).toBe(CounterPanel);
  });
});
