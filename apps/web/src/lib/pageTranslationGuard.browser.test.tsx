import { describe, expect, it } from "vite-plus/test";

import { render } from "../../test/render";
import { guardDomAgainstPageTranslation } from "./pageTranslationGuard";

// What Chrome's page translator does: swap each text node for <font><font>translation</font></font>.
function translatePage(root: Element) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode as Text);
  for (const text of textNodes) {
    if (!text.nodeValue?.trim()) continue;
    const outer = document.createElement("font");
    const inner = document.createElement("font");
    inner.textContent = `译:${text.nodeValue}`;
    outer.append(inner);
    text.replaceWith(outer);
  }
}

function Status({ running }: { running: boolean }) {
  return (
    <div>
      {running ? "Working" : <i data-testid="done" />}
      {"for 2s"}
    </div>
  );
}

describe("guardDomAgainstPageTranslation", () => {
  it("keeps React committing after page translation replaced its text nodes", async () => {
    guardDomAgainstPageTranslation();
    await using screen = await render(<Status running />, { router: false });
    translatePage(screen.container);

    // Removing "Working" hits removeChild; placing the icon before "for 2s" hits insertBefore.
    await screen.rerender(<Status running={false} />);
    await expect.element(screen.getByTestId("done")).toBeInTheDocument();
    await screen.rerender(<Status running />);
    await expect.element(screen.getByTestId("done")).not.toBeInTheDocument();
  });
});
