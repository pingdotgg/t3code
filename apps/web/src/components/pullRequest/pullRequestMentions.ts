type MentionNode = {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: MentionNode[];
  position?: { start: { offset?: number }; end: { offset?: number } };
};

const IGNORED_ELEMENTS = new Set(["a", "code", "pre", "kbd", "samp", "script", "style"]);
const MENTION_PATTERN = /@([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)/gu;
const BEFORE_MENTION = /[\p{L}\p{N}_@/\\]/u;
const AFTER_MENTION = /[\p{L}\p{N}_/-]/u;
const AUTHORED_AT = /\\[!-/:-@[-`{-~]|&#0{0,5}64;|&#[xX]0{0,4}40;|&commat;|@/gu;

function authoredMentionOffsets(value: string, authored: string) {
  // Align every @, including escapes and entities, before matching usernames.
  // Searching by username confuses an encoded mention with a later literal one.
  const authoredAts = [...authored.matchAll(AUTHORED_AT)].filter(
    (match) => match[0] === "@" || match[0] === "\\@" || match[0].startsWith("&"),
  );
  const renderedAts = [...value.matchAll(/@/gu)];
  if (authoredAts.length !== renderedAts.length) return new Map<number, number>();
  return new Map(
    renderedAts.flatMap((match, index) => {
      const sourceAt = authoredAts[index]!;
      return sourceAt[0] === "@" ? [[match.index, sourceAt.index] as const] : [];
    }),
  );
}

/** Run after raw HTML and sanitization, so mentions in details work without trusting authored markers. */
export function rehypePullRequestMentions(options: {
  readonly repositoryUrl: string;
  readonly viewer?: string | null;
}) {
  const origin = new URL(options.repositoryUrl).origin;
  const viewer = options.viewer?.toLowerCase();
  return (tree: MentionNode, file: { value?: unknown }) => {
    const source = typeof file.value === "string" ? file.value : undefined;
    visit(tree);

    function visit(node: MentionNode): void {
      if (!node.children || (node.tagName && IGNORED_ELEMENTS.has(node.tagName))) return;
      node.children = node.children.flatMap((child) => {
        if (child.type !== "text" || child.value === undefined) {
          visit(child);
          return [child];
        }
        const value = child.value;
        if (!value.includes("@")) return [child];
        const startOffset = child.position?.start.offset;
        const endOffset = child.position?.end.offset;
        const authored =
          source !== undefined && startOffset !== undefined && endOffset !== undefined
            ? source.slice(startOffset, endOffset)
            : undefined;
        const parts: MentionNode[] = [];
        let cursor = 0;
        const authoredOffsets =
          authored === undefined ? undefined : authoredMentionOffsets(value, authored);
        for (const match of value.matchAll(MENTION_PATTERN)) {
          const login = match[1]!;
          const before = value[match.index - 1];
          const after = value[match.index + match[0].length];
          const authoredIndex = authoredOffsets?.get(match.index);
          if (
            login.length > 39 ||
            login.includes("--") ||
            (before !== undefined && BEFORE_MENTION.test(before)) ||
            (after !== undefined && AFTER_MENTION.test(after)) ||
            (authored !== undefined &&
              (authoredIndex === undefined || !authored.startsWith(match[0], authoredIndex)))
          ) {
            continue;
          }
          if (cursor < match.index)
            parts.push({ type: "text", value: value.slice(cursor, match.index) });
          parts.push({
            type: "element",
            tagName: "a",
            properties: {
              href: `${origin}/${login}`,
              dataPullRequestMention: login.toLowerCase() === viewer ? "self" : "user",
            },
            children: [{ type: "text", value: match[0] }],
          });
          cursor = match.index + match[0].length;
        }
        if (cursor === 0) return [child];
        if (cursor < value.length) parts.push({ type: "text", value: value.slice(cursor) });
        return parts;
      });
    }
  };
}
