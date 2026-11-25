import type { Element, Root, RootContent } from "hast";

// Not `table`: each row is read as its own block.
const SPEECH_BLOCK_TAGS = new Set(["p", "li", "h1", "h2", "h3", "h4", "h5", "h6", "tr"]);

/** Tags block elements with their markdown range so read aloud can find the block it reads. */
export function rehypeSpeechOffsets() {
  const visit = (node: Root | RootContent) => {
    if (node.type === "element" && SPEECH_BLOCK_TAGS.has(node.tagName)) tag(node);
    if ("children" in node) node.children.forEach(visit);
  };
  return visit;
}

function tag(node: Element) {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (start !== undefined && end !== undefined)
    node.properties = { ...node.properties, dataSpeechStart: start, dataSpeechEnd: end };
}
