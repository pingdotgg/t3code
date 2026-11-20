import { Children, isValidElement, type ReactNode } from "react";
import type { ExtraProps } from "react-markdown";

const FENCE_LANGUAGE = /(?:^|\s)language-([^\s]+)/;
const FENCE_TITLE_ATTR = /(?:^|\s)(?:title|file(?:name)?)=(?:"([^"]+)"|'([^']+)'|(\S+))/i;
const FENCE_FILENAME_TOKEN = /^[\w@][\w@./-]*\.[A-Za-z0-9]+$/;

/** The highlighter's name for the language a fence's class names. Plain text when it names none. */
export function extractFenceLanguage(className: string | undefined): string {
  const language = FENCE_LANGUAGE.exec(className ?? "")?.[1] ?? "text";
  // The highlighter bundles no gitignore grammar; ini is a close match.
  return language === "gitignore" ? "ini" : language;
}

/** The file name a fence's info string gives, as `title="a.ts"` or a bare `a.ts`. */
export function extractFenceTitle(meta: string | undefined): string | null {
  if (!meta) return null;
  const attribute = FENCE_TITLE_ATTR.exec(meta);
  const title = attribute?.[1] ?? attribute?.[2] ?? attribute?.[3];
  if (title) return title;
  return meta.split(/\s+/).find((candidate) => FENCE_FILENAME_TOKEN.test(candidate)) ?? null;
}

/** The info string after the language, which remark leaves on the `code` node inside a `pre`. */
export function extractPreCodeMeta(node: ExtraProps["node"]): string | undefined {
  const code = node?.children.find((child) => child.type === "element" && child.tagName === "code");
  const meta =
    code?.type === "element"
      ? String(code.properties["dataCodeMeta"] ?? code.data?.["meta"] ?? "").trim()
      : "";
  return meta === "" ? undefined : meta;
}

/** Whether the fence has its closing line, which a reply that is still streaming lacks. */
export function isClosedCodeFence(node: ExtraProps["node"], text: string, code: string): boolean {
  const start = node?.position?.start.offset;
  const end = node?.position?.end.offset;
  if (start === undefined || end === undefined) return false;
  const source = text.slice(start, end);
  const opening = /^(?:`{3,}|~{3,})/.exec(source)?.[0];
  // One class for the blockquote prefix: nested quantifiers here backtrack
  // exponentially on code lines that start with many `> ` markers.
  const closing = /(?:^|\n)[ \t>]*(`{3,}|~{3,})[ \t\r]*$/.exec(source)?.[1];
  return (
    opening !== undefined &&
    closing !== undefined &&
    opening[0] === closing[0] &&
    closing.length >= opening.length &&
    // Only a real closer is omitted from the parsed code.
    source.replace(/\r$/, "").split(/\r\n|\r|\n/).length > code.split(/\r\n|\r|\n/).length
  );
}

export function nodeToPlainText(node: ReactNode): string {
  if (Array.isArray(node)) return node.map((child) => nodeToPlainText(child)).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return nodeToPlainText(node.props.children);
  return node === null || node === undefined || node === true || node === false ? "" : String(node);
}

interface FencedCode {
  readonly className?: string;
  readonly children?: ReactNode;
  readonly node?: { readonly tagName?: string };
}

/** The class and text of a `pre` that holds exactly one `code`, or null for any other `pre`. */
export function extractCodeBlock(
  children: ReactNode,
): { className: string | undefined; code: string } | null {
  const nodes = Children.toArray(children);
  const only = nodes[0];
  if (nodes.length !== 1 || !isValidElement<FencedCode>(only)) return null;
  // With a custom `code` component the child's type is that component, so its hast node names the tag.
  if (only.type !== "code" && only.props.node?.tagName !== "code") return null;
  return { className: only.props.className, code: nodeToPlainText(only.props.children) };
}
