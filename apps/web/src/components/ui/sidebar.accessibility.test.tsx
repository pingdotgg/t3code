// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => DEFAULT_RESOLVED_KEYBINDINGS }));
vi.mock("../../state/server", () => ({ primaryServerKeybindingsAtom: {} }));
vi.mock("../../hooks/useAccessibilitySupport", () => ({ useAccessibilitySupport: () => false }));
vi.mock("../../hooks/useMediaQuery", () => ({ useIsMobile: () => false }));
import { Sidebar, SidebarProvider, SidebarTrigger, useSidebar } from "./sidebar";
import { WorkspaceNavigation, useWorkspaceArea } from "../WorkspaceNavigation";

let root: Root;
let container: HTMLDivElement;
function Controls() {
  const { setOpen } = useSidebar();
  return (
    <>
      <SidebarTrigger />
      <button onClick={() => setOpen(false)}>Hide sidebar</button>
    </>
  );
}
function Fixture() {
  const area = useWorkspaceArea("sidebar", 0, "Threads");
  return (
    <SidebarProvider>
      <Sidebar {...area} data-app-sidebar>
        <button>First thread</button>
        <button>Second thread</button>
      </Sidebar>
      <section {...useWorkspaceArea("composer", 2, "Message input")}>
        <textarea aria-label="Message input" />
      </section>
      <Controls />
      <WorkspaceNavigation />
    </SidebarProvider>
  );
}
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("cookieStore", { set: vi.fn().mockResolvedValue(undefined) });
  vi.useFakeTimers();
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([
    { width: 10, height: 10 },
  ] as unknown as DOMRectList);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<Fixture />));
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function frame() {
  await act(async () => vi.advanceTimersToNextFrame());
}

it("announces actual toggles, excludes collapsed content and restores the last thread when reopened", async () => {
  expect(document.querySelector('[role="alert"]')).toBeNull();
  const threads = container.querySelectorAll<HTMLButtonElement>("[data-app-sidebar] button");
  const toggle = container.querySelector<HTMLButtonElement>('[data-sidebar="trigger"]')!;
  threads[1]!.focus();
  // Like a shortcut, this invokes the action while focus remains in the sidebar.
  await act(async () => toggle.click());
  await frame();
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(threads[1]!.closest('[inert][aria-hidden="true"]')).not.toBeNull();
  expect(document.activeElement?.getAttribute("aria-label")).toBe("Message input");
  expect(document.getElementById("workspace-visibility-alerts")?.textContent).toBe(
    "Threads sidebar hidden",
  );
  await act(async () => toggle.click());
  await frame();
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(threads[1]!.closest("[inert]")).toBeNull();
  expect(document.activeElement).toBe(threads[1]);
  const alerts = Array.from(document.querySelectorAll('[role="alert"]'));
  expect(alerts.filter((alert) => alert.textContent)).toHaveLength(1);
  expect(alerts.find((alert) => alert.textContent)?.textContent).toBe("Threads sidebar shown");
});

it("does not repeat a hidden announcement or disturb visible content for an unchanged state", async () => {
  const composer = container.querySelector("textarea")!;
  composer.focus();
  const hide = Array.from(container.querySelectorAll("button")).find(
    (button) => button.textContent === "Hide sidebar",
  )!;
  await act(async () => hide.click());
  await frame();
  const firstAlert = Array.from(document.querySelectorAll('[role="alert"]')).find(
    (alert) => alert.textContent,
  );
  await act(async () => hide.click());
  await frame();
  expect(
    Array.from(document.querySelectorAll('[role="alert"]')).find((alert) => alert.textContent),
  ).toBe(firstAlert);
  expect(document.activeElement).toBe(composer);
});
