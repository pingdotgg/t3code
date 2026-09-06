import { createMemoryHistory } from "@tanstack/react-router";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { useEscapeToGoBack } from "./useNavigateBack";

let history: ReturnType<typeof createMemoryHistory>;
const navigate = ({ to }: { to: string }) => history.push(to);

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useCanGoBack: () => history.canGoBack(),
  useNavigate: () => navigate,
}));

let renderer: ReactTestRenderer | undefined;
let events: EventTarget;
const blur = vi.fn();

function Page() {
  useEscapeToGoBack();
  return null;
}

async function openPage(entries: string[]) {
  history = createMemoryHistory({ initialEntries: entries });
  events = new EventTarget();
  vi.stubGlobal("window", Object.assign(events, { history }));
  await act(() => {
    renderer = create(<Page />);
  });
}

function pressKey(init: KeyboardEventInit = {}) {
  const event = Object.assign(new Event("keydown", { cancelable: true }), {
    key: "Escape",
    repeat: false,
    isComposing: false,
    ...init,
  });
  events.dispatchEvent(event);
  return event;
}

beforeEach(() => {
  class FocusedElement {
    blur = blur;
  }
  blur.mockClear();
  vi.stubGlobal("HTMLElement", FocusedElement);
  vi.stubGlobal("document", { activeElement: new FocusedElement() });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

describe("Escape page navigation", () => {
  it("returns to the previous app page and releases input focus", async () => {
    await openPage(["/env/thread", "/pull-requests"]);
    expect(pressKey().defaultPrevented).toBe(true);
    expect(history.location.pathname).toBe("/env/thread");
    expect(blur).toHaveBeenCalledOnce();
  });

  it("returns home when the page was opened without app history", async () => {
    await openPage(["/usage"]);
    pressKey();
    expect(history.location.pathname).toBe("/");
  });

  it("lets an editor or popup consume Escape before navigating", async () => {
    await openPage(["/env/thread", "/pull-requests"]);
    const event = Object.assign(new Event("keydown", { cancelable: true }), { key: "Escape" });
    event.preventDefault();
    events.dispatchEvent(event);
    expect(history.location.pathname).toBe("/pull-requests");
    expect(blur).not.toHaveBeenCalled();

    pressKey();
    expect(history.location.pathname).toBe("/env/thread");
  });

  it.each([{ repeat: true }, { isComposing: true }, { key: "Enter" }])(
    "does not navigate for %j",
    async (init) => {
      await openPage(["/env/thread", "/usage"]);
      expect(pressKey(init).defaultPrevented).toBe(false);
      expect(history.location.pathname).toBe("/usage");
      expect(blur).not.toHaveBeenCalled();
    },
  );

  it("stops handling Escape after leaving the page", async () => {
    await openPage(["/env/thread", "/usage"]);
    await act(() => renderer?.unmount());
    renderer = undefined;
    expect(pressKey().defaultPrevented).toBe(false);
    expect(history.location.pathname).toBe("/usage");
  });
});
