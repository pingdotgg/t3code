export const COMPOSER_EDITOR_NAMESPACE = "t3tools-composer-editor";

function containsTerminalContextNode(nodes: unknown[]): boolean {
  return nodes.some((node) => {
    if (typeof node !== "object" || node === null) {
      return false;
    }
    if ("type" in node && node.type === "composer-terminal-context") {
      return true;
    }
    return "children" in node && Array.isArray(node.children)
      ? containsTerminalContextNode(node.children)
      : false;
  });
}

export function isComposerLexicalClipboardPayload(payload: string): boolean {
  try {
    const parsed: unknown = JSON.parse(payload);
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      "namespace" in parsed &&
      parsed.namespace === COMPOSER_EDITOR_NAMESPACE &&
      "nodes" in parsed &&
      Array.isArray(parsed.nodes) &&
      !containsTerminalContextNode(parsed.nodes)
    );
  } catch {
    return false;
  }
}
