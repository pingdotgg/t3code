import type { Nodes } from "mdast";
import type { Code, Tokenizer } from "micromark-util-types";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified, type Data, type Processor } from "unified";

import { githubEmojiAliases } from "./githubEmojiAliases.generated.ts";

declare module "micromark-util-types" {
  interface TokenTypeMap {
    githubEmoji: "githubEmoji";
  }
}

declare module "mdast" {
  interface RootData {
    /** Source ranges of the aliases this parse expanded, in document order. */
    githubEmoji?: { start: number; end: number; emoji: string }[];
  }
}

type FromMarkdownExtension = Exclude<
  NonNullable<Data["fromMarkdownExtensions"]>[number],
  unknown[]
>;
type CompileContext = ThisParameterType<NonNullable<FromMarkdownExtension["enter"]>[string]>;

const COLON = 58;
// The alias alphabet: a-z, 0-9, `_`, `+` and `-`.
const isAliasCode = (code: Code): code is number =>
  code !== null &&
  ((code >= 97 && code <= 122) ||
    (code >= 48 && code <= 57) ||
    code === 95 ||
    code === 43 ||
    code === 45);

const tokenize: Tokenizer = (effects, ok, nok) => {
  let name = "";
  return (code) => {
    effects.enter("githubEmoji");
    effects.consume(code);
    return inside;
  };
  function inside(code: Code) {
    if (code === COLON && Object.hasOwn(githubEmojiAliases, name)) {
      effects.consume(code);
      effects.exit("githubEmoji");
      return ok;
    }
    if (!isAliasCode(code)) return nok(code);
    name += String.fromCharCode(code);
    effects.consume(code);
    return inside;
  }
};

// GitHub leaves text inside these elements alone. Comments and attributes are matched whole so a
// `<code>` written inside them opens nothing.
const IGNORED_ELEMENTS = new Set(["code", "pre", "tt"]);
const HTML_TAG = /<!--[^]*?(?:-->|$)|<(\/?)([a-z][a-z\d-]*)(?:[^"'<>]|"[^"]*"|'[^']*')*>/giu;
const htmlCodeStates = new WeakMap<object, { nextChild: number; depth: number }>();

function insideRawHtmlCode(stack: CompileContext["stack"]) {
  return stack.some((node) => {
    if (!("children" in node)) return false;
    let state = htmlCodeStates.get(node);
    if (!state) {
      state = { nextChild: 0, depth: 0 };
      htmlCodeStates.set(node, state);
    }
    // Compilation only appends children; scan each HTML node once.
    for (; state.nextChild < node.children.length; state.nextChild++) {
      const child = node.children[state.nextChild]!;
      if (child.type !== "html") continue;
      for (const [, closing, name] of child.value.matchAll(HTML_TAG)) {
        if (name && IGNORED_ELEMENTS.has(name.toLowerCase())) {
          state.depth = Math.max(0, state.depth + (closing ? -1 : 1));
        }
      }
    }
    return state.depth > 0;
  });
}

const fromMarkdown: FromMarkdownExtension = {
  enter: {
    githubEmoji(token) {
      this.config.enter.data!.call(this, token);
    },
  },
  exit: {
    githubEmoji(token) {
      const text = this.stack.at(-1);
      this.config.exit.data!.call(this, token);
      if (text?.type !== "text" || insideRawHtmlCode(this.stack)) return;
      const alias = this.sliceSerialize(token);
      const emoji = githubEmojiAliases[alias.slice(1, -1)]!;
      text.value = text.value.slice(0, -alias.length) + emoji;
      const root = this.stack[0];
      if (root?.type === "root") {
        ((root.data ??= {}).githubEmoji ??= []).push({
          start: token.start.offset,
          end: token.end.offset,
          emoji,
        });
      }
    },
  },
};

/**
 * Renders GitHub's `:alias:` emoji in prose. Expanding while parsing leaves code, escapes, link
 * destinations, autolinks and source positions exactly as markdown already reads them.
 */
function attachGithubEmoji(this: Processor) {
  const data = this.data();
  (data.micromarkExtensions ??= []).push({ text: { [COLON]: { name: "githubEmoji", tokenize } } });
  (data.fromMarkdownExtensions ??= []).push(fromMarkdown);
}
export const remarkGithubEmoji = attachGithubEmoji;

const parser = unified().use(remarkParse).use(remarkGfm).use(remarkGithubEmoji);
const ALIAS_CANDIDATE = /:([a-z\d_+-]+)(?=:)/gu;
const unchanged = (offset: number) => offset;

function mentionsAlias(source: string) {
  for (const [, name] of source.matchAll(ALIAS_CANDIDATE)) {
    if (Object.hasOwn(githubEmojiAliases, name!)) return true;
  }
  return false;
}

/**
 * For renderers that take markdown text. `sourceOffset` maps an offset in the expanded markdown,
 * such as a task marker, back to `source`.
 */
export function expandGithubEmoji(source: string): {
  readonly markdown: string;
  readonly sourceOffset: (offset: number) => number;
} {
  const tree = mentionsAlias(source) ? parser.parse(source) : undefined;
  const expansions = tree?.data?.githubEmoji;
  if (!tree || !expansions) return { markdown: source, sourceOffset: unchanged };
  // Native reparsing resolves shortcut and collapsed links by their authored label.
  const references: { start: number; end: number }[] = [];
  const collectReferences = (node: Nodes) => {
    if (
      (node.type === "linkReference" || node.type === "imageReference") &&
      node.referenceType !== "full"
    ) {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start !== undefined && end !== undefined) references.push({ start, end });
    } else if ("children" in node) node.children.forEach(collectReferences);
  };
  collectReferences(tree);
  let referenceIndex = 0;
  let markdown = "";
  let cursor = 0;
  // Where each expansion ends in `markdown`, and how far `source` is ahead from there on.
  const shifts: { end: number; delta: number }[] = [];
  for (const { start, end, emoji } of expansions) {
    while (references[referenceIndex] && references[referenceIndex]!.end <= start) referenceIndex++;
    const reference = references[referenceIndex];
    if (reference && reference.start <= start && end <= reference.end) continue;
    // A native reparse would read the keycap's `*` as emphasis.
    markdown += source.slice(cursor, start) + emoji.replaceAll("*", "\\*");
    cursor = end;
    shifts.push({ end: markdown.length, delta: end - markdown.length });
  }
  markdown += source.slice(cursor);
  return {
    markdown,
    sourceOffset(offset) {
      let delta = 0;
      for (const shift of shifts) {
        if (shift.end > offset) break;
        delta = shift.delta;
      }
      return offset + delta;
    },
  };
}
