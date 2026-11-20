/**
 * Marks the line of the code in `container` and scrolls it to the middle. The highlighter draws
 * after the first render, so this waits for the line to appear. The returned function unmarks it.
 */
export function revealLine(container: HTMLElement, line: number): () => void {
  let marked: Element | undefined;
  const mark = () => {
    const row = container.querySelector("code")?.children[line - 1];
    if (row === undefined) return false;
    marked = row;
    row.setAttribute("data-marked", "true");
    row.scrollIntoView({ block: "center" });
    return true;
  };
  const observer = new MutationObserver(() => {
    if (mark()) observer.disconnect();
  });
  if (!mark()) observer.observe(container, { childList: true, subtree: true });
  return () => {
    observer.disconnect();
    marked?.removeAttribute("data-marked");
  };
}
