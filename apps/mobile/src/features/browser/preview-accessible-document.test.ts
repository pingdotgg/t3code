import { createAccessibleDocumentView } from "@t3tools/client-runtime/preview/accessible-document";
import type { PreviewAccessibilityDocument } from "@t3tools/contracts";
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
