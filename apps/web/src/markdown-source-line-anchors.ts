type MarkdownNode = {
  type?: string;
  position?: {
    start?: {
      line?: number;
    };
  };
  data?: {
    hProperties?: Record<string, unknown>;
  };
  children?: MarkdownNode[];
};

const ANCHORED_BLOCK_TYPES = new Set([
  "blockquote",
  "code",
  "heading",
  "html",
  "list",
  "listItem",
  "paragraph",
  "table",
  "thematicBreak",
]);

export function remarkSourceLineAnchors() {
  return (tree: MarkdownNode) => {
    const visit = (node: MarkdownNode) => {
      const sourceLine = node.position?.start?.line;
      if (ANCHORED_BLOCK_TYPES.has(node.type ?? "") && Number.isSafeInteger(sourceLine)) {
        node.data = {
          ...node.data,
          hProperties: {
            ...node.data?.hProperties,
            dataSourceLine: sourceLine,
          },
        };
      }
      node.children?.forEach(visit);
    };

    visit(tree);
  };
}
