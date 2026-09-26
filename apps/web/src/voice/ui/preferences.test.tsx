// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { useVoiceFastCommands } from "./preferences";

it("keeps both subscribers usable when saving the preference throws", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("localStorage", {
    getItem: () => null,
    setItem: () => {
      throw new Error("Storage unavailable");
    },
  });
  function Toggle() {
    const [enabled, setEnabled] = useVoiceFastCommands();
    return <button onClick={() => setEnabled(!enabled)}>{String(enabled)}</button>;
  }
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <>
          <Toggle />
          <Toggle />
        </>,
      ),
    );
    expect(container.textContent).toBe("truetrue");
    await act(async () => container.querySelector("button")!.click());
    expect(container.textContent).toBe("falsefalse");
    await act(async () => container.querySelector("button")!.click());
    expect(container.textContent).toBe("truetrue");
    const recovered = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => recovered.get(key) ?? null,
      setItem: (key: string, value: string) => recovered.set(key, value),
    });
    await act(async () => container.querySelector("button")!.click());
    expect(recovered.get("t3code:voice-fast-commands:v1")).toBe("false");
    recovered.set("t3code:voice-fast-commands:v1", "true");
    await act(async () => window.dispatchEvent(new Event("storage")));
    expect(container.textContent).toBe("truetrue");
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});
