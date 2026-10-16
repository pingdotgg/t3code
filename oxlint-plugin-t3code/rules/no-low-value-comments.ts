import { defineRule, type ESTree } from "@oxlint/plugins";

const TS_FILE_PATTERN = /\.[cm]?tsx?$/u;
const DIRECTIVE_PATTERN =
  /^\s*(?:(?:oxlint|eslint)-|@ts-|@effect-diagnostics|prettier-ignore|biome-ignore|c8 |istanbul |#(?:end)?region)/u;
const DIVIDER_LINE_PATTERN = /^(?:[-=*#~_/+]{3,}.*|.*[-=*#~_]{3,})$/u;
const TEST_STEP_PATTERN = /^(?:arrange|act|assert|given|when|then)\s*[:.]?$/iu;
const TASK_MARKER_PATTERN = /\b(?:TODO|FIXME|XXX|HACK)\b/u;
const TASK_LINK_PATTERN = /#\d+|https?:\/\//u;
const JSDOC_TYPE_PATTERN = /^@(?:param|returns?|type|typedef)\s+\{/u;
const EMPTY_JSDOC_TAG_PATTERN = /^@(?:param(?:\s+\[?[\w$.]+\]?)?|returns?)$/u;
const COMMENTED_CODE_PATTERN =
  /^(?:(?:(?:const|let|var)\s+[\w${}[\], ]+=.*|import\s.+\sfrom\s+["'].+["']|(?:await\s+|return\s+)?[\w$.]+\(.*\)|[\w$.[\]]+\s*=\s*.+);|(?:if|for|while|switch)\s*\(.*\)\s*\{|\}(?:\s*else\s*\{)?)$/u;
const DECLARATION_PATTERN =
  /^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?(?:static\s+)?(?:readonly\s+)?(?:(?:const|let|var|function\*?|class|interface|type|enum)\s+)?([A-Za-z_$][\w$]*)\s*[?!]?\s*[:=(<{]/u;
const FILLER_WORDS = new Set(
  "a an the of for to in on at by with from and or is are be this that it its as get set return create new current value given whether".split(
    " ",
  ),
);

const stem = (word: string) => (word.length > 3 ? word.replace(/([^s])s$/u, "$1") : word);
const words = (text: string) =>
  (text.toLowerCase().match(/[a-z0-9]+/gu) ?? [])
    .filter((word) => !FILLER_WORDS.has(word))
    .map(stem)
    .filter((word) => !FILLER_WORDS.has(word));
const identifierWords = (name: string) =>
  words(name.replace(/([a-z0-9])([A-Z])/gu, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/gu, "$1 $2"));

const commentLines = (comment: ESTree.Comment) =>
  comment.value
    .split("\n")
    .map((line) => line.replace(/^\s*\*?\s?/u, "").trim())
    .filter((line) => line !== "");

export default defineRule({
  meta: {
    type: "suggestion",
    docs: {
      description: "Reject comments that only repeat the code, divide sections, or narrate tests.",
    },
  },
  create(context) {
    const { sourceCode } = context;
    const isTypeScript = TS_FILE_PATTERN.test(context.filename);

    // Consecutive `//` lines at one indent read as one comment.
    const groups: Array<{ comments: Array<ESTree.Comment>; lines: Array<string> }> = [];
    for (const comment of sourceCode.getAllComments()) {
      const previous = groups.at(-1)?.comments.at(-1);
      const continues =
        comment.type === "Line" &&
        previous?.type === "Line" &&
        previous.loc.end.line === comment.loc.start.line - 1 &&
        previous.loc.start.column === comment.loc.start.column;
      if (continues) {
        groups.at(-1)!.comments.push(comment);
        groups.at(-1)!.lines.push(...commentLines(comment));
      } else {
        groups.push({ comments: [comment], lines: commentLines(comment) });
      }
    }

    const restatesNextName = (lastLine: number, lines: ReadonlyArray<string>) => {
      if (lines.some((line) => line.startsWith("@"))) return false;
      const name = DECLARATION_PATTERN.exec(sourceCode.lines[lastLine] ?? "")?.[1];
      if (name === undefined) return false;
      const content = words(lines.join(" "));
      if (content.length === 0 || content.length > 6) return false;
      const nameWords = new Set(identifierWords(name));
      return content.every((word) => nameWords.has(word));
    };

    const problem = (comments: ReadonlyArray<ESTree.Comment>, lines: ReadonlyArray<string>) => {
      const text = comments.map((comment) => comment.value).join("\n");
      if (lines.length === 0 || comments.some((comment) => DIRECTIVE_PATTERN.test(comment.value))) {
        return undefined;
      }
      const isLine = comments[0]!.type === "Line";
      if (lines.some((line) => DIVIDER_LINE_PATTERN.test(line))) {
        return "Drop the section divider; split the file or let the code's structure show the grouping.";
      }
      if (isLine && lines.length === 1 && TEST_STEP_PATTERN.test(lines[0]!)) {
        return "Drop the test step label.";
      }
      if (TASK_MARKER_PATTERN.test(text) && !TASK_LINK_PATTERN.test(text)) {
        return "Link the issue that tracks this, or drop the marker.";
      }
      if (isTypeScript && lines.some((line) => JSDOC_TYPE_PATTERN.test(line))) {
        return "Drop the JSDoc type; TypeScript already has it.";
      }
      if (lines.some((line) => EMPTY_JSDOC_TAG_PATTERN.test(line))) {
        return "Drop the JSDoc tag that has no description.";
      }
      if (isLine && lines.every((line) => COMMENTED_CODE_PATTERN.test(line))) {
        return "Delete commented-out code; git keeps the history.";
      }
      if (restatesNextName(comments.at(-1)!.loc.end.line, lines)) {
        return "Drop the comment; it only repeats the name below it. Say why, or say nothing.";
      }
      return undefined;
    };

    return {
      Program() {
        for (const { comments, lines } of groups) {
          const message = problem(comments, lines);
          if (message === undefined) continue;
          context.report({
            loc: { start: comments[0]!.loc.start, end: comments.at(-1)!.loc.end },
            message,
          });
        }
      },
    };
  },
});
