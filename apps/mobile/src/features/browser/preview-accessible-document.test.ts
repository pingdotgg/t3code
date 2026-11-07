import { createAccessibleDocumentView } from "@t3tools/client-runtime/preview/accessible-document";
import {
  PREVIEW_ACCESSIBILITY_VALUE_MAX_CHARS,
  type PreviewAccessibilityAction,
  type PreviewAccessibilityDocument,
} from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

it("preserves drafts and submits only values the viewer edited", () => {
  const container = document.createElement("div");
  document.body.append(container);
  const onAction = vi.fn(() => true);
  const view = createAccessibleDocumentView(container, { onAction });
  const page: PreviewAccessibilityDocument = {
    document: "page",
    version: 1,
    truncated: false,
    root: {
      id: "root",
      role: "document",
      children: [{ id: "field", role: "textbox", name: "Name", value: "Server" }],
    },
  };
  try {
    view.update(page, true);
    const input = container.querySelector("input")!;
    input.focus();
    input.value = "Unsent draft";
    input.setSelectionRange(3, 6);
    input.dispatchEvent(new Event("input", { bubbles: true }));

    view.update({ ...page, version: 2, root: { ...page.root, name: "Updated title" } }, true);

    expect(document.activeElement).toBe(input);
    expect(input.value).toBe("Unsent draft");
    expect([input.selectionStart, input.selectionEnd]).toEqual([3, 6]);
    expect(onAction).not.toHaveBeenCalled();

    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(input.value).toBe("Server");
    expect(onAction).not.toHaveBeenCalled();

    const oversized = "x".repeat(PREVIEW_ACCESSIBILITY_VALUE_MAX_CHARS + 1);
    input.value = oversized;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(onAction).not.toHaveBeenCalled();
    expect(container.querySelector('[role="status"]')!.textContent).toContain("10,000");
    input.blur();
    view.update({ ...page, version: 3 }, true);
    expect(input.value).toBe(oversized);
    input.value = "Shortened draft";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onAction).toHaveBeenLastCalledWith({
      type: "accessibilityAction",
      document: "page",
      node: "field",
      action: "setValue",
      value: "Shortened draft",
    });

    view.update(
      { ...page, version: 4, root: { id: "secret", role: "textbox", protected: true } },
      true,
    );
    const secret = container.querySelector("input")!;
    secret.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(onAction).toHaveBeenLastCalledWith({
      type: "accessibilityAction",
      document: "page",
      node: "secret",
      action: "setValue",
      submit: true,
    });
    for (const value of ["Replacement", ""]) {
      secret.value = value;
      secret.dispatchEvent(new Event("input", { bubbles: true }));
      if (value)
        secret.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      else secret.dispatchEvent(new Event("change", { bubbles: true }));
      expect(onAction).toHaveBeenLastCalledWith({
        type: "accessibilityAction",
        document: "page",
        node: "secret",
        action: "setValue",
        ...(value ? { submit: true } : {}),
        value,
      });
    }
  } finally {
    view.destroy();
    container.remove();
  }
});

it("toggles one option of a multiple select without clearing the others", () => {
  const container = document.createElement("div");
  document.body.append(container);
  const onAction = vi.fn((_action: PreviewAccessibilityAction) => true);
  const view = createAccessibleDocumentView(container, { onAction });
  const option = (id: string, selected: boolean) => ({ id, role: "option", name: id, selected });
  const page = (selected: ReadonlyArray<boolean>): PreviewAccessibilityDocument => ({
    document: "page",
    version: 1,
    truncated: false,
    root: {
      id: "root",
      role: "listbox",
      name: "Windows",
      multiselectable: true,
      children: ["morning", "afternoon", "evening"].map((id, index) =>
        option(id, selected[index]!),
      ),
    },
  });
  try {
    view.update(page([true, true, false]), true);
    const select = container.querySelector("select")!;
    const selected = () => [...select.options].map((each) => each.selected);
    expect(selected()).toEqual([true, true, false]);

    select.options[2]!.selected = true;
    select.dispatchEvent(new Event("change", { bubbles: true }));
    select.options[0]!.selected = false;
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onAction.mock.calls.map(([action]) => action.node)).toEqual(["evening", "morning"]);
    expect(selected()).toEqual([false, true, true]);
  } finally {
    view.destroy();
    container.remove();
  }
});
