import { useRef } from "react";
import { expect, it, vi } from "vite-plus/test";
import { render } from "../../test/render";
import { keepClosingPane, usePaneMotion } from "./paneMotion";

vi.mock("../hooks/useSettings", () => ({
  useClientSettings: () => 150,
}));

function Panes({ closed }: { closed: boolean }) {
  const stage = useRef<HTMLDivElement>(null);
  usePaneMotion(stage, "workspace", true, () => {}, closed);
  return (
    <div style={{ width: 500, height: 300 }}>
      <div ref={stage} style={{ position: "relative", width: 500, height: 300 }}>
        <div
          data-layout-pane-id="donor"
          data-layout-tab-id="donor"
          style={{ position: "absolute", left: 0, width: 200, height: 300 }}
        />
        {closed ? (
          <div
            key="ghost"
            data-layout-closing="preview"
            style={{ position: "absolute", left: 216, width: 200, height: 300 }}
          />
        ) : (
          <div
            key="preview"
            data-layout-pane-id="preview"
            data-layout-tab-id="preview"
            style={{ position: "absolute", left: 216, width: 200, height: 300 }}
          >
            <div data-preview />
          </div>
        )}
      </div>
    </div>
  );
}

it("keeps open and nested shadow content in the closing preview even if another root cannot attach", async () => {
  await using screen = await render(<Panes closed={false} />);
  const pane = screen.container.querySelector<HTMLElement>('[data-layout-tab-id="preview"]')!;
  const host = pane.querySelector("[data-preview]")!;
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = "<pre>const preview = true;</pre><div data-nested></div>";
  shadow.querySelector("[data-nested]")!.attachShadow({ mode: "open" }).innerHTML =
    "<code>nested diff content</code>";
  const unavailable = document.createElement("div");
  unavailable.attachShadow({ mode: "open" }).textContent = "unavailable";
  pane.prepend(unavailable);
  const attachShadow = Element.prototype.attachShadow;
  using _attach = vi.spyOn(Element.prototype, "attachShadow").mockImplementation(function (
    this: Element,
    init,
  ) {
    if (!this.hasAttribute("data-preview") && !this.hasAttribute("data-nested")) {
      throw new DOMException("Shadow root unavailable", "NotSupportedError");
    }
    return attachShadow.call(this, init);
  });
  keepClosingPane("preview", pane);
  await screen.rerender(<Panes closed />);
  const ghost = screen.container.querySelector("[data-layout-closing]")!;
  const copied = ghost.querySelector("[data-preview]")?.shadowRoot;
  expect(copied?.querySelector("pre")?.textContent).toBe("const preview = true;");
  expect(copied?.querySelector("[data-nested]")?.shadowRoot?.textContent).toBe(
    "nested diff content",
  );
  expect(ghost.querySelector("[data-preview]")).not.toBe(host);
});
