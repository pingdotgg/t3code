// @vitest-environment jsdom
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Dialog } from "@base-ui/react/dialog";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { useCommandPaletteState } from "./CommandPalette.state";
import { requestWorkspaceFocus } from "../lib/workspaceFocus";

function Palette() {
  const { state, dispatch, getReturnFocus } = useCommandPaletteState();
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (!event.ctrlKey || (event.key !== "k" && event.key !== "p")) return;
      dispatch({ _tag: "ToggleMode", mode: event.key === "k" ? "command" : "files" });
      if (!state.open && document.activeElement instanceof HTMLElement) {
        // JSDOM doesn't implement inert's blur. Reproduce the browser losing focus
        // before Base UI mounts its focus manager, after the open command captures it.
        document.activeElement.blur();
      }
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [dispatch, state.open]);
  return (
    <Dialog.Root
      open={state.open}
      onOpenChange={(open, details) => {
        if (!open && details.reason === "escape-key" && state.mode !== "command") {
          details.cancel();
          dispatch({ _tag: "ToggleMode", mode: "command" });
          return;
        }
        dispatch({ _tag: "SetOpen", open });
      }}
    >
      <div inert={state.open}>
        <input aria-label="Search settings" />
        <button>Usage filter</button>
      </div>
      <Dialog.Portal>
        <Dialog.Popup aria-label="Command palette" finalFocus={getReturnFocus}>
          <input aria-label="Palette search" />
          <button
            onClick={() => {
              window.history.pushState({}, "", "/usage");
              dispatch({ _tag: "SetOpen", open: false });
            }}
          >
            Open Usage
          </button>
          <button
            onClick={() => {
              requestWorkspaceFocus({ area: "panel" });
              dispatch({ _tag: "SetOpen", open: false });
            }}
          >
            Open panel
          </button>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

let root: Root;
let container: HTMLDivElement;
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  window.history.replaceState({}, "", "/settings");
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([
    { width: 10, height: 10 },
  ] as unknown as DOMRectList);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<Palette />));
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
async function press(key: string, ctrlKey = false) {
  await act(async () => {
    document.activeElement!.dispatchEvent(
      new KeyboardEvent("keydown", { key, ctrlKey, bubbles: true, cancelable: true }),
    );
  });
  await act(async () => vi.runOnlyPendingTimers());
}

it("restores the pre-open control after inert blurred it before popup mount", async () => {
  const search = container.querySelector("input")!;
  search.focus();
  await press("k", true);
  expect(document.activeElement).toBe(document.querySelector('[aria-label="Palette search"]'));
  await press("Escape");
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.activeElement).toBe(search);
});

it("keeps the original control when switching modes, then captures a fresh target next time", async () => {
  const search = container.querySelector("input")!;
  const filter = container.querySelector("button")!;
  search.focus();
  await press("k", true);
  await press("p", true);
  await press("Escape");
  expect(document.activeElement).toBe(document.querySelector('[aria-label="Palette search"]'));
  await press("Escape");
  expect(document.activeElement).toBe(search);
  filter.focus();
  await press("k", true);
  await press("Escape");
  expect(document.activeElement).toBe(filter);
});

it.each(["Open Usage", "Open panel"])(
  "leaves focus to the destination of %s instead of the old opener",
  async (action) => {
    const search = container.querySelector("input")!;
    search.focus();
    await press("k", true);
    const button = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button'),
    ).find((item) => item.textContent === action)!;
    await act(async () => button.click());
    expect(document.activeElement).not.toBe(search);
    const destination = container.querySelector("button")!;
    destination.focus();
    await act(async () => vi.runOnlyPendingTimers());
    expect(document.activeElement).toBe(destination);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  },
);
