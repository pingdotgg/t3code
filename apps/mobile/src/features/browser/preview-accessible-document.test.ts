import { createAccessibleDocumentView } from "@t3tools/client-runtime/preview/accessible-document";
import type { PreviewAccessibilityAction, PreviewAccessibilityDocument } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

it("keeps an unsent field edit through unrelated page updates and cancels it on Escape", () => {
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
