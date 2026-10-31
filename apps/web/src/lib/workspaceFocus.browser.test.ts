import { describe, expect, it, vi } from "vite-plus/test";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { DraftId } from "../composerDraftStore";
import { selectFocusedTab } from "../layout/layoutModel";
import { useLayoutStore } from "../layout/layoutStore";
import { createWorkspaceFocusController } from "./workspaceFocus";

function setup() {
  const root = document.createElement("div");
  document.body.append(root);
  const controller = createWorkspaceFocusController(document);
  const area = (name: string, order: number, parent: HTMLElement = root) => {
    const element = document.createElement("section");
    element.dataset.workspaceArea = name;
    element.dataset.workspaceOrder = String(order);
    element.tabIndex = -1;
    const button = document.createElement("button");
    button.textContent = name;
    element.append(button);
    parent.append(element);
    return { element, button };
  };
  const append = (html: string) => {
    root.insertAdjacentHTML("beforeend", html);
    return root.lastElementChild as HTMLElement;
  };
  return {
    area,
    append,
    controller,
    [Symbol.dispose]() {
      controller.dispose();
      root.remove();
    },
  };
}

describe("workspace area focus", () => {
  it("cycles through matching areas in separate panes and remembers each control", () => {
    using fixture = setup();
    const sidebar = fixture.area("sidebar", 0);
    const firstPane = fixture.append('<div data-layout-tab-id="first"></div>');
    const secondPane = fixture.append('<div data-layout-tab-id="second"></div>');
    const first = fixture.area("composer", 2, firstPane);
    const second = fixture.area("composer", 2, secondPane);
    const remembered = document.createElement("button");
    remembered.textContent = "Second control";
    second.element.append(remembered);
    remembered.focus();
    sidebar.button.focus();
    expect(fixture.controller.move(1)).toBe(true);
    expect(document.activeElement).toBe(first.button);
    expect(fixture.controller.move(1)).toBe(true);
    expect(document.activeElement).toBe(remembered);
    expect(fixture.controller.move(-1)).toBe(true);
    expect(document.activeElement).toBe(first.button);
  });

  it("waits for a requested panel in its originating pane", async () => {
    using fixture = setup();
    const firstPane = fixture.append('<div data-layout-tab-id="first"></div>');
    const secondPane = fixture.append('<div data-layout-tab-id="second"></div>');
    const composer = fixture.area("composer", 2, firstPane);
    fixture.area("panel", 4, secondPane);
    composer.button.focus();
    fixture.controller.request({ area: "panel" });
    const panel = fixture.area("panel", 4, firstPane);
    await vi.waitFor(() => expect(document.activeElement).toBe(panel.button));
  });

  it("waits for the requested thread's surface instead of another panel", async () => {
    using fixture = setup();
    const original = useLayoutStore.getState().layout;
    using _restore = { [Symbol.dispose]: () => useLayoutStore.setState({ layout: original }) };
    const otherRef = scopeThreadRef(EnvironmentId.make("other"), ThreadId.make("thread"));
    const targetRef = scopeThreadRef(EnvironmentId.make("target"), ThreadId.make("thread"));
    useLayoutStore.getState().openTab({ kind: "surface", threadRef: otherRef, surfaceId: "diff" });
    const otherTab = selectFocusedTab(useLayoutStore.getState().layout)!;
    useLayoutStore
      .getState()
      .openTab(
        { kind: "surface", threadRef: targetRef, surfaceId: "diff" },
        { placement: "new-column" },
      );
    const targetTab = selectFocusedTab(useLayoutStore.getState().layout)!;
    const otherPane = fixture.append("<div></div>");
    otherPane.dataset.layoutTabId = otherTab.id;
    const other = fixture.area("panel", 4, otherPane);
    other.button.focus();
    fixture.controller.request({
      area: "panel",
      surface: { threadKey: scopedThreadKey(targetRef), surfaceId: "diff" },
    });
    const targetPane = fixture.append("<div></div>");
    targetPane.dataset.layoutTabId = targetTab.id;
    const target = fixture.area("panel", 4, targetPane);
    await vi.waitFor(() => expect(document.activeElement).toBe(target.button));
  });

  it("skips a pane outside the clipped layout viewport", () => {
    using fixture = setup();
    const sidebar = fixture.area("sidebar", 0);
    const clip = fixture.append(
      '<div data-layout-clip="" style="position:relative;width:100px;height:100px;overflow:hidden"></div>',
    );
    const pane = document.createElement("div");
    pane.dataset.layoutTabId = "offscreen";
    pane.style.cssText = "position:absolute;left:200px;top:0;width:100px;height:100px";
    clip.append(pane);
    fixture.area("composer", 2, pane);
    sidebar.button.focus();
    expect(fixture.controller.move(1)).toBe(true);
    expect(document.activeElement).toBe(sidebar.button);
  });

  it("cycles in workspace order in both directions, independent of DOM order", () => {
    using fixture = setup();
    const panel = fixture.area("panel", 3);
    const sidebar = fixture.area("sidebar", 0);
    const conversation = fixture.area("conversation", 1);
    const composer = fixture.area("composer", 2);
    sidebar.button.focus();
    fixture.controller.move(1);
    // The conversation is a region; it takes focus itself rather than its first button.
    expect(document.activeElement).toBe(conversation.element);
    fixture.controller.move(1);
    expect(document.activeElement).toBe(composer.button);
    fixture.controller.move(1);
    expect(document.activeElement).toBe(panel.button);
    fixture.controller.move(1);
    expect(document.activeElement).toBe(sidebar.button);
    fixture.controller.move(-1);
    expect(document.activeElement).toBe(panel.button);
  });

  it("skips hidden, inert, and maximized-away areas", () => {
    using fixture = setup();
    const sidebar = fixture.area("sidebar", 0);
    const conversation = fixture.area("conversation", 1);
    const composer = fixture.area("composer", 2);
    const panel = fixture.area("panel", 3);
    const terminal = fixture.area("terminal", 4);
    conversation.element.dataset.chatColumnMaximizedAway = "true";
    composer.element.hidden = true;
    panel.element.dataset.workspaceUnavailable = "true";
    terminal.element.inert = true;
    sidebar.button.focus();
    expect(fixture.controller.move(1)).toBe(true);
    expect(document.activeElement).toBe(sidebar.button);
  });

  it("restores the last focused control and falls back when it is removed", () => {
    using fixture = setup();
    fixture.area("sidebar", 0);
    const composer = fixture.area("composer", 2);
    const remembered = document.createElement("button");
    remembered.textContent = "remembered";
    composer.element.append(remembered);
    remembered.focus();
    fixture.controller.move(-1);
    fixture.controller.move(1);
    expect(document.activeElement).toBe(remembered);
    fixture.controller.move(-1);
    remembered.remove();
    fixture.controller.move(1);
    expect(document.activeElement).toBe(composer.button);
  });

  it("keeps focus inside a dialog or an open popup", () => {
    using fixture = setup();
    fixture.area("sidebar", 0);
    fixture.area("panel", 3);
    const dialog = fixture.append('<div role="dialog" tabindex="-1">Confirm</div>');
    dialog.focus();
    expect(fixture.controller.move(1)).toBe(false);
    expect(document.activeElement).toBe(dialog);
    dialog.remove();

    const popup = fixture.append(
      '<div role="listbox" data-slot="select-popup"><button role="option">Choice</button></div>',
    );
    const choice = popup.querySelector("button")!;
    choice.focus();
    expect(fixture.controller.move(1)).toBe(false);
    expect(document.activeElement).toBe(choice);
  });

  it("keeps moving while a non-modal notification is visible", () => {
    using fixture = setup();
    const composer = fixture.area("composer", 2);
    const panel = fixture.area("panel", 4);
    fixture.append(
      '<div data-slot="toast-viewport"><div role="dialog" aria-modal="false" tabindex="0">Update available</div></div>',
    );
    composer.button.focus();
    expect(fixture.controller.move(1)).toBe(true);
    expect(document.activeElement).toBe(panel.button);
  });

  it("moves only between the areas of an open Settings modal", () => {
    using fixture = setup();
    fixture.area("sidebar", 0);
    fixture.area("composer", 2);
    const modal = fixture.append('<div role="dialog" data-app-modal=""></div>');
    const nav = fixture.area("settings-nav", 0, modal);
    const content = fixture.area("settings", 1, modal);
    nav.button.focus();
    expect(fixture.controller.move(1)).toBe(true);
    expect(document.activeElement).toBe(content.button);
    expect(fixture.controller.move(1)).toBe(true);
    expect(document.activeElement).toBe(nav.button);
  });

  it("keeps moving while a shortcut recorder is on the page but not focused", () => {
    using fixture = setup();
    const nav = fixture.area("settings-nav", 0);
    const content = fixture.area("settings", 1);
    fixture.append('<button data-keybinding-capture="">Record shortcut</button>');
    nav.button.focus();
    expect(fixture.controller.move(1)).toBe(true);
    expect(document.activeElement).toBe(content.button);
  });

  it("brings a restored control back into view inside its own list", () => {
    using fixture = setup();
    const sidebar = fixture.area("sidebar", 0);
    const list = document.createElement("div");
    list.style.cssText = "height: 50px; overflow-y: auto";
    const spacer = document.createElement("div");
    spacer.style.height = "400px";
    const row = document.createElement("button");
    row.textContent = "Last thread";
    list.append(spacer, row);
    sidebar.element.append(list);
    const composer = fixture.area("composer", 2);
    row.focus();
    fixture.controller.move(1);
    expect(document.activeElement).toBe(composer.button);
    list.scrollTop = 0;
    fixture.controller.move(-1);
    expect(document.activeElement).toBe(row);
    expect(list.scrollTop).toBeGreaterThan(0);
  });

  it("reveals a restored control through nested scrolling lists", () => {
    using fixture = setup();
    const settings = fixture.area("settings", 1);
    const page = document.createElement("div");
    page.style.cssText = "height: 80px; overflow-y: auto";
    const inner = document.createElement("div");
    inner.style.cssText = "height: 60px; overflow-y: auto";
    const field = document.createElement("button");
    field.textContent = "Provider field";
    inner.append(Object.assign(document.createElement("div"), { style: "height: 200px" }), field);
    page.append(inner, Object.assign(document.createElement("div"), { style: "height: 400px" }));
    settings.element.append(page);
    const nav = fixture.area("settings-nav", 0);
    field.focus();
    fixture.controller.move(-1);
    expect(document.activeElement).toBe(nav.button);
    inner.scrollTop = 0;
    page.scrollTop = 300;
    fixture.controller.move(1);
    expect(document.activeElement).toBe(field);
    const box = page.getBoundingClientRect();
    const rect = field.getBoundingClientRect();
    expect(rect.bottom > box.top && rect.top < box.bottom).toBe(true);
  });

  it("does not scroll the conversation to an old control", () => {
    using fixture = setup();
    const conversation = fixture.area("conversation", 1);
    const timeline = document.createElement("div");
    timeline.style.cssText = "height: 50px; overflow-y: auto";
    const copy = document.createElement("button");
    copy.textContent = "Copy";
    timeline.append(copy, Object.assign(document.createElement("div"), { style: "height: 400px" }));
    conversation.element.append(timeline);
    const composer = fixture.area("composer", 2);
    copy.focus();
    fixture.controller.move(1);
    expect(document.activeElement).toBe(composer.button);
    // Live follow moved the timeline to the newest output.
    timeline.scrollTop = 300;
    fixture.controller.move(-1);
    expect(document.activeElement).toBe(conversation.element);
    expect(timeline.scrollTop).toBe(300);
  });

  it("returns focus to the area when its focused control disappears", async () => {
    using fixture = setup();
    const panel = fixture.area("panel", 3);
    const tab = document.createElement("button");
    tab.textContent = "Files tab";
    panel.element.append(tab);
    tab.focus();
    tab.remove();
    await vi.waitFor(() => expect(document.activeElement).toBe(panel.button));
  });

  it("falls back to the main content when the whole area disappears", async () => {
    using fixture = setup();
    const composer = fixture.area("composer", 2);
    const details = fixture.area("details", 3);
    details.button.focus();
    details.element.hidden = true;
    await vi.waitFor(() => expect(document.activeElement).toBe(composer.button));
  });

  it("keeps focus on the control a panel tab switch came from", () => {
    using fixture = setup();
    const panel = fixture.area("panel", 3);
    const content = document.createElement("div");
    content.setAttribute("data-right-panel-surface-content", "");
    const row = (name: string) => {
      const button = document.createElement("button");
      button.textContent = name;
      content.append(button);
      return button;
    };
    const earlierRow = row("reference-analysis.md");
    const clickedRow = row("print-guide.md");
    panel.element.append(content);
    panel.element.dataset.workspaceFocusKey = "panel:file:print-guide.md";
    earlierRow.focus();
    panel.element.dataset.workspaceFocusKey = "panel:file:reference-analysis.md";
    clickedRow.focus();
    panel.element.dataset.workspaceFocusKey = "panel:file:print-guide.md";
    expect(fixture.controller.focus("panel")).toBe(true);
    expect(document.activeElement).toBe(clickedRow);
  });

  it("cycles to the launcher and returns there when a panel disappears", async () => {
    using fixture = setup();
    const sidebar = fixture.area("sidebar", 0);
    const launcher = fixture.area("launcher", 1);
    const panel = fixture.area("panel", 4);
    sidebar.button.focus();
    expect(fixture.controller.move(1)).toBe(true);
    expect(document.activeElement).toBe(launcher.button);
    expect(fixture.controller.move(1)).toBe(true);
    expect(document.activeElement).toBe(panel.button);
    panel.element.hidden = true;
    await vi.waitFor(() => expect(document.activeElement).toBe(launcher.button));
  });

  it("waits for a requested area to mount", async () => {
    using fixture = setup();
    fixture.area("composer", 2);
    fixture.controller.request({ area: "pull-requests" });
    const list = fixture.area("pull-requests", 1);
    await vi.waitFor(() => expect(document.activeElement).toBe(list.button));
  });

  it("keeps focus on a control that React remounted elsewhere", async () => {
    using fixture = setup();
    fixture.area("composer", 2);
    const header = fixture.append("<header></header>");
    const toggle = document.createElement("button");
    toggle.setAttribute("aria-label", "Toggle right panel");
    header.append(toggle);
    toggle.focus();
    const moved = toggle.cloneNode() as HTMLButtonElement;
    toggle.remove();
    header.append(moved);
    await vi.waitFor(() => expect(document.activeElement).toBe(moved));
  });

  it("keeps moving while a hover popup without focus is open", () => {
    using fixture = setup();
    const composer = fixture.area("composer", 2);
    const terminal = fixture.area("terminal", 4);
    fixture.append('<div data-slot="popover-popup">New split terminal</div>');
    composer.button.focus();
    expect(fixture.controller.move(1)).toBe(true);
    expect(document.activeElement).toBe(terminal.button);
  });

  it("cycles through every area of each visible pane and skips inactive tabs", () => {
    using fixture = setup();
    const sidebar = fixture.area("sidebar", 0);
    const first = fixture.append('<div data-layout-tab-id="first"></div>');
    const firstTabs = fixture.area("tabs", 0.5, first);
    const firstConversation = fixture.area("conversation", 1, first);
    const firstComposer = fixture.area("composer", 2, first);
    const second = fixture.append('<div data-layout-tab-id="second"></div>');
    const secondTabs = fixture.area("tabs", 0.5, second);
    const secondConversation = fixture.area("conversation", 1, second);
    const secondComposer = fixture.area("composer", 2, second);
    const inactive = fixture.append('<div data-layout-tab-id="inactive" inert></div>');
    fixture.area("composer", 2, inactive);
    sidebar.button.focus();
    for (const target of [
      firstTabs.button,
      firstConversation.element,
      firstComposer.button,
      secondTabs.button,
      secondConversation.element,
      secondComposer.button,
      sidebar.button,
    ]) {
      expect(fixture.controller.move(1)).toBe(true);
      expect(document.activeElement).toBe(target);
    }
    fixture.controller.move(-1);
    expect(document.activeElement).toBe(secondComposer.button);
    fixture.controller.move(-1);
    expect(document.activeElement).toBe(secondConversation.element);
  });

  it("restores panel controls independently in panes with the same surface key", () => {
    using fixture = setup();
    const sidebar = fixture.area("sidebar", 0);
    const first = fixture.append('<div data-layout-tab-id="first"></div>');
    const firstPanel = fixture.area("panel", 3, first);
    firstPanel.element.dataset.workspaceFocusKey = "panel:files";
    const firstControl = document.createElement("button");
    firstControl.setAttribute("aria-label", "Expand folder");
    firstPanel.element.append(firstControl);
    const second = fixture.append('<div data-layout-tab-id="second"></div>');
    const secondPanel = fixture.area("panel", 3, second);
    secondPanel.element.dataset.workspaceFocusKey = "panel:files";
    const secondControl = firstControl.cloneNode() as HTMLButtonElement;
    secondPanel.element.append(secondControl);
    firstControl.focus();
    secondControl.focus();
    sidebar.button.focus();
    fixture.controller.move(1);
    expect(document.activeElement).toBe(firstControl);
    fixture.controller.move(1);
    expect(document.activeElement).toBe(secondControl);
  });

  it("targets content and panel requests in the focused pane", () => {
    using fixture = setup();
    const first = fixture.append('<div data-layout-tab-id="first"></div>');
    fixture.area("composer", 2, first);
    const firstPanel = fixture.area("panel", 3, first);
    const second = fixture.append(
      '<div data-layout-tab-id="second" data-layout-pane-focused="true"></div>',
    );
    const composer = fixture.area("composer", 2, second);
    const panel = fixture.area("panel", 3, second);
    expect(fixture.controller.focus("content")).toBe(true);
    expect(document.activeElement).toBe(composer.button);
    expect(fixture.controller.focus("panel")).toBe(true);
    expect(document.activeElement).toBe(panel.button);
    composer.element.hidden = true;
    expect(fixture.controller.focus("content")).toBe(true);
    expect(document.activeElement).toBe(panel.button);
    expect(fixture.controller.move(-1, "panel")).toBe(true);
    expect(document.activeElement).toBe(firstPanel.button);
    panel.button.focus();
    panel.element.hidden = true;
    expect(fixture.controller.focus("content")).toBe(false);
    const mountedComposer = fixture.area("composer", 2, second);
    expect(fixture.controller.focus("content")).toBe(true);
    expect(document.activeElement).toBe(mountedComposer.button);
  });

  it("changes keyboard ownership only when explicitly moving focus to a pane", () => {
    using fixture = setup();
    const original = useLayoutStore.getState().layout;
    using _restore = { [Symbol.dispose]: () => useLayoutStore.setState({ layout: original }) };
    useLayoutStore.getState().openTab({
      kind: "chat",
      target: { kind: "draft", draftId: DraftId.make("focus-first") },
    });
    const firstTab = selectFocusedTab(useLayoutStore.getState().layout)!;
    useLayoutStore
      .getState()
      .openTab(
        { kind: "chat", target: { kind: "draft", draftId: DraftId.make("focus-second") } },
        { placement: "new-column" },
      );
    const secondTab = selectFocusedTab(useLayoutStore.getState().layout)!;
    const first = fixture.append("<div></div>");
    first.dataset.layoutTabId = firstTab.id;
    const firstComposer = fixture.area("composer", 2, first);
    const second = fixture.append("<div></div>");
    second.dataset.layoutTabId = secondTab.id;
    const secondComposer = fixture.area("composer", 2, second);
    firstComposer.button.focus();
    expect(selectFocusedTab(useLayoutStore.getState().layout)?.id).toBe(secondTab.id);
    secondComposer.button.focus();
    fixture.controller.move(-1);
    expect(document.activeElement).toBe(firstComposer.button);
    expect(selectFocusedTab(useLayoutStore.getState().layout)?.id).toBe(firstTab.id);
  });
});
