// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { useVoiceOverlayPreferences } from "./overlayPreferences";

it("mounts stored preferences without looping and updates both subscribers on local and external writes", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const key = "t3code:voice-overlay:v1";
  localStorage.setItem(key, JSON.stringify({ collapsed: false, activation: "hold" }));
  let renders = 0;
  function Toggle() {
    const [prefs, update] = useVoiceOverlayPreferences();
    renders += 1;
    if (renders > 30) throw new Error("Overlay snapshot render loop");
    return (
      <button
        onClick={() => update({ collapsed: !prefs.collapsed })}
      >{`${prefs.activation}:${prefs.collapsed}`}</button>
    );
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
    expect(container.textContent).toBe("hold:falsehold:false");
    await act(async () => container.querySelector("button")!.click());
    expect(container.textContent).toBe("hold:truehold:true");
    expect(JSON.parse(localStorage.getItem(key)!)).toMatchObject({
      activation: "hold",
      collapsed: true,
    });
    localStorage.setItem(key, JSON.stringify({ collapsed: false, activation: "always" }));
    await act(async () => window.dispatchEvent(new Event("storage")));
    expect(container.textContent).toBe("always:falsealways:false");
    localStorage.removeItem(key);
    await act(async () => window.dispatchEvent(new Event("storage")));
    expect(container.textContent).toBe("manual:truemanual:true");
    localStorage.setItem(key, "invalid json");
    await act(async () => window.dispatchEvent(new Event("storage")));
    expect(container.textContent).toBe("manual:truemanual:true");
  } finally {
    await act(async () => root.unmount());
    localStorage.clear();
    vi.unstubAllGlobals();
  }
});
