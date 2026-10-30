import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../test/render";
import { TerminalViewport } from "./ThreadTerminalDrawer";

vi.mock("../terminal/ghostty/vendor/ghostty-vt.wasm?url", async () => ({
  default: (await import("../terminal/ghostty/vendor/ghostty-vt.wasm?inline")).default,
}));
vi.mock("../terminal/ghostty/vendor/ghostty-write-pty.wasm?url&no-inline", async () => ({
  default: (await import("../terminal/ghostty/vendor/ghostty-write-pty.wasm?inline")).default,
}));

// Thread navigation defaults have no `!terminalFocus`, so they apply in a focused terminal.
it("hands thread navigation shortcuts from a focused terminal back to the app", async () => {
  using _platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
  const threadId = ThreadId.make("thread");
  const container = document.createElement("div");
  container.style.cssText = "position:relative;width:600px;height:300px";
  await using screen = await render(
    <TerminalViewport
      advancedTypography={false}
      threadRef={{ environmentId: EnvironmentId.make("local"), threadId }}
      threadId={threadId}
      terminalId="term-1"
      terminalLabel="Terminal 1"
      cwd="/repo"
      onSessionExited={() => {}}
      visible
      keybindings={DEFAULT_RESOLVED_KEYBINDINGS}
    />,
    { container },
  );
  // The drawer marks the input once the surface has loaded and handles keys.
  const input = await vi.waitFor(() => {
    const element = screen.container.querySelector<HTMLTextAreaElement>(
      ".t3-ghostty-input[data-workspace-focus-default]",
    );
    if (!element) throw new Error("Terminal surface did not load");
    return element;
  });
  input.focus();
  const reachedApp: string[] = [];
  const onWindowKeyDown = (event: KeyboardEvent) => {
    if (!event.defaultPrevented && event.code.startsWith("Bracket")) reachedApp.push(event.code);
  };
  window.addEventListener("keydown", onWindowKeyDown);
  using _listener = {
    [Symbol.dispose]: () => window.removeEventListener("keydown", onWindowKeyDown),
  };

  await userEvent.keyboard("{Control>}{Shift>}[BracketLeft][BracketRight]{/Shift}{/Control}");

  expect(reachedApp).toEqual(["BracketLeft", "BracketRight"]);
});
