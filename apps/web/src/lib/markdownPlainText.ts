const FENCED_CODE_BLOCK_REGEX = /(^|\n)(`{3,}|~{3,})[^\n]*\n([\s\S]*?)\n\2(?=\n|$)/g;
const INLINE_CODE_REGEX = /`([^`\n]+)`/g;
const IMAGE_LINK_REGEX = /!\[([^\]]*)\]\((?:\\.|[^)])*\)/g;
const INLINE_LINK_REGEX = /\[([^\]]+)\]\((?:\\.|[^)])*\)/g;
const REFERENCE_LINK_REGEX = /\[([^\]]+)\]\[[^\]]*]/g;
const REFERENCE_DEFINITION_REGEX = /^\s{0,3}\[[^\]]+]:\s+\S+(?:\s+.+)?$/gm;
const HTML_COMMENT_REGEX = /<!--[\s\S]*?-->/g;
const AUTOLINK_REGEX = /<((?:https?|mailto):[^>\s]+)>/g;
const HTML_TAG_REGEX = /<\/?[^>\n]+>/g;
const HEADING_PREFIX_REGEX = /^\s{0,3}#{1,6}\s+/gm;
const BLOCKQUOTE_PREFIX_REGEX = /^\s{0,3}>\s?/gm;
const LIST_PREFIX_REGEX = /^\s{0,3}(?:[-+*]|\d+[.)])\s+/gm;
const THEMATIC_BREAK_REGEX = /^\s{0,3}(?:[-*_]\s*){3,}$/gm;
const EMPHASIS_REGEXES = [/(\*\*\*|___)(.*?)\1/gs, /(\*\*|__)(.*?)\1/gs, /(~~)(.*?)\1/gs] as const;

export function markdownToPlainText(markdown: string): string {
  let text = markdown.replace(/\r\n?/g, "\n");

  text = text.replace(HTML_COMMENT_REGEX, " ");
  text = text.replace(
    FENCED_CODE_BLOCK_REGEX,
    (_match, prefix: string, _fence: string, code: string) => `${prefix}${code}\n`,
  );
  text = text.replace(IMAGE_LINK_REGEX, "$1");
  text = text.replace(INLINE_LINK_REGEX, "$1");
  text = text.replace(REFERENCE_LINK_REGEX, "$1");
  text = text.replace(REFERENCE_DEFINITION_REGEX, "");
  text = text.replace(AUTOLINK_REGEX, "$1");
  text = text.replace(INLINE_CODE_REGEX, "$1");

  for (const regex of EMPHASIS_REGEXES) {
    text = text.replace(regex, "$2");
  }

  text = text.replace(HEADING_PREFIX_REGEX, "");
  text = text.replace(BLOCKQUOTE_PREFIX_REGEX, "");
  text = text.replace(LIST_PREFIX_REGEX, "");
  text = text.replace(THEMATIC_BREAK_REGEX, "");
  text = text.replace(HTML_TAG_REGEX, " ");

  return text.trim();
}
