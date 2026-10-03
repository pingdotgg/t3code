/** Decorations are background images: copying, selection and the editor still see original bytes. */
export const CODE_WHITESPACE_UNSAFE_CSS = `
:host([data-show-whitespace]) [data-code] [data-whitespace] {
  background-position: left center;
  background-size: 1ch 1em;
}
:host([data-show-whitespace]) [data-code] [data-whitespace="space"] {
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 20'%3E%3Ccircle cx='5' cy='10' r='1.2' fill='%23888'/%3E%3C/svg%3E");
  background-repeat: repeat-x;
}
:host([data-show-whitespace]) [data-code] [data-whitespace="tab"] {
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 20'%3E%3Cpath d='M1 10h7M5 7l3 3-3 3' stroke='%23888' fill='none'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
}
`;

const decoratedText = new WeakSet<Text>();

/** Called after Pierre renders; only mounted code rows are visited, never comments or chrome. */
export function renderCodeWhitespace(container: HTMLElement, showWhitespace: boolean): void {
  container.toggleAttribute("data-show-whitespace", showWhitespace);
  if (!showWhitespace) return;
  const root = container.shadowRoot ?? container;
  decorateCodeLines(container, root.querySelectorAll("[data-code] [data-line]"));
}

/** Pierre patches edited rows without calling onPostRender. Observe only those rows. */
export function observeCodeWhitespace(container: HTMLElement): () => void {
  const root = container.shadowRoot ?? container;
  const observer = new MutationObserver((mutations) => {
    const lines = new Set<Element>();
    for (const mutation of mutations) {
      const target =
        mutation.target instanceof Element ? mutation.target : mutation.target.parentElement;
      const line = target?.closest("[data-code] [data-line]");
      if (line) lines.add(line);
      for (const node of mutation.addedNodes) {
        if (!(node instanceof Element)) continue;
        if (node.matches("[data-code] [data-line]")) lines.add(node);
        for (const addedLine of node.querySelectorAll("[data-code] [data-line]")) {
          lines.add(addedLine);
        }
      }
    }
    if (lines.size === 0) return;
    observer.disconnect();
    decorateCodeLines(
      container,
      [...lines].filter((line) => root.contains(line)),
    );
    observe();
  });
  const observe = () => observer.observe(root, { childList: true, subtree: true });
  observe();
  return () => observer.disconnect();
}

function decorateCodeLines(container: HTMLElement, lines: Iterable<Element>): void {
  const selection = container.ownerDocument.getSelection();
  let anchorNode = selection?.anchorNode ?? null;
  let focusNode = selection?.focusNode ?? null;
  let anchorOffset = selection?.anchorOffset ?? 0;
  let focusOffset = selection?.focusOffset ?? 0;
  let selectionChanged = false;
  for (const line of lines) {
    // Grammarless editor patches contain one raw text node. Pierre's caret resolver cannot
    // traverse decoration spans on that plain-text path; give the whole line one indexed token,
    // whose nested text it can map in both directions. Keep highlighted token boundaries intact.
    if (!line.querySelector("[data-char]") && /[ \t]/.test(line.textContent ?? "")) {
      if (line.contains(anchorNode) || line.contains(focusNode)) selectionChanged = true;
      const token = container.ownerDocument.createElement("span");
      token.dataset.char = "0";
      token.append(...line.childNodes);
      line.append(token);
    }
    const walker = container.ownerDocument.createTreeWalker(line, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    while (walker.nextNode()) {
      const node = walker.currentNode as Text;
      if (!decoratedText.has(node) && !node.parentElement?.closest("[data-whitespace]")) {
        nodes.push(node);
      }
    }
    for (const node of nodes) {
      decoratedText.add(node);
      if (!/[ \t]/.test(node.data)) continue;
      const fragment = container.ownerDocument.createDocumentFragment();
      let offset = 0;
      for (const part of node.data.split(/( +|\t)/)) {
        if (!part) continue;
        const text = container.ownerDocument.createTextNode(part);
        decoratedText.add(text);
        if (anchorNode === node && anchorOffset <= offset + part.length) {
          anchorNode = text;
          anchorOffset -= offset;
          selectionChanged = true;
        }
        if (focusNode === node && focusOffset <= offset + part.length) {
          focusNode = text;
          focusOffset -= offset;
          selectionChanged = true;
        }
        offset += part.length;
        if (part === "\t" || /^ +$/.test(part)) {
          const span = container.ownerDocument.createElement("span");
          span.dataset.whitespace = part === "\t" ? "tab" : "space";
          span.append(text);
          fragment.append(span);
        } else {
          fragment.append(text);
        }
      }
      node.replaceWith(fragment);
    }
  }
  if (selectionChanged && anchorNode !== null && focusNode !== null) {
    selection?.setBaseAndExtent(anchorNode, anchorOffset, focusNode, focusOffset);
  }
}
