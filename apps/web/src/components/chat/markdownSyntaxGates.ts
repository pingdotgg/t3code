import type { Nodes as MdastNodes } from "mdast";
import {
  type Extension as MdastExtension,
  fromMarkdown,
  type Options as FromMarkdownOptions,
  type Transform,
} from "mdast-util-from-markdown";
import { combineExtensions } from "micromark-util-combine-extensions";
import type { Construct, Extension, TokenizeContext } from "micromark-util-types";
import type { Processor } from "unified";

// A table needs a delimiter row: dashes with a `|` or `:`, after any `>` or indent.
// One character class per pattern: overlapping ones backtrack quadratically on a run of dashes.
const DELIMITER_LINE = /^[ \t>|:-]+$/gm;
const isDelimiterRow = (line: string) => line.includes("-") && /[|:]/.test(line);
const NEXT_LINE = /[^\r\n]*(?:\r\n?|\n)([^\r\n]*)/y;

function hasDelimiterRow(text: string) {
  for (const [line] of text.matchAll(DELIMITER_LINE)) if (isDelimiterRow(line)) return true;
  return false;
}
const PROTOCOL = /https?:\/\//iy;
const WWW = /www\./iy;
const EMAIL_ATEXT = /[\w+.-]*@/y;

const matchesAt = (pattern: RegExp, text: string, offset: number) => {
  pattern.lastIndex = offset;
  return pattern.test(text);
};

interface Gate {
  readonly names: ReadonlyArray<string>;
  /** False when the construct cannot match anywhere in the text. */
  readonly inText: (text: string) => boolean;
  /** False when it cannot start at this offset, which keeps micromark from trying it there. */
  readonly at?: (context: TokenizeContext, text: string, offset: number) => boolean;
}

// micromark tries these at every candidate character: email autolinks at every word, tables
// at every line. That is most of what GFM adds to a parse, and most texts cannot match them.
const GATES: ReadonlyArray<Gate> = [
  {
    names: ["emailAutolink"],
    inText: (text) => text.includes("@"),
    at: (_, text, offset) => matchesAt(EMAIL_ATEXT, text, offset),
  },
  {
    names: ["protocolAutolink"],
    inText: (text) => /https?:\/\//i.test(text),
    at: (_, text, offset) => matchesAt(PROTOCOL, text, offset),
  },
  {
    names: ["wwwAutolink"],
    inText: (text) => /www\./i.test(text),
    at: (_, text, offset) => matchesAt(WWW, text, offset),
  },
  {
    names: ["table"],
    inText: hasDelimiterRow,
    at: (context, text, offset) => {
      NEXT_LINE.lastIndex = offset;
      const nextLine = NEXT_LINE.exec(text)?.[1];
      return (nextLine !== undefined && hasDelimiterRow(nextLine)) || continuesTable(context);
    },
  },
  { names: ["strikethrough"], inText: (text) => text.includes("~") },
  {
    names: ["gfmFootnoteCall", "gfmPotentialFootnoteCall", "gfmFootnoteDefinition"],
    inText: (text) => text.includes("[^"),
  },
  { names: ["tasklistCheck"], inText: (text) => /\[[\sxX]\]/.test(text) },
];

// A body row follows the head or another row. Mirrors `start` in micromark-extension-gfm-table's
// lib/syntax.js: recheck it when that package changes.
function continuesTable({ events }: TokenizeContext) {
  let index = events.length - 1;
  while (index > -1 && /^(?:lineEnding|linePrefix)$/.test(events[index]![1].type)) index--;
  // The table extension's token types are not in micromark's map unless its types are loaded.
  const tail: string | undefined = events[index]?.[1].type;
  return tail === "tableHead" || tail === "tableRow";
}

let parsing = "";
const gated = new WeakMap<Construct, Construct>();

function gatedConstruct(construct: Construct, gate: Gate): Construct {
  const at = gate.at;
  if (!at) return construct;
  let wrapped = gated.get(construct);
  if (!wrapped) {
    const { previous, tokenize } = construct;
    wrapped = {
      ...construct,
      tokenize(effects, ok, nok) {
        return at(this, parsing, this.now().offset) ? tokenize.call(this, effects, ok, nok) : nok;
      },
      ...(previous && {
        previous(code) {
          return previous.call(this, code) && at(this, parsing, this.now().offset);
        },
      }),
    };
    gated.set(construct, wrapped);
  }
  return wrapped;
}

type ConstructMap = Record<string, Construct | Construct[] | undefined>;

function gateExtension(extension: Extension, absent: ReadonlySet<Gate>): Extension {
  const gateOf = (name: string | undefined) =>
    GATES.find((gate) => name && gate.names.includes(name));
  const result: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(extension)) {
    if (field === "disable" || field === "attentionMarkers" || !value) {
      result[field] = value;
      continue;
    }
    const map: ConstructMap = {};
    for (const [code, entry] of Object.entries(value as ConstructMap)) {
      const kept = (Array.isArray(entry) ? entry : [entry]).flatMap((construct) => {
        const gate = construct && gateOf(construct.name);
        if (!construct || !gate) return construct ? [construct] : [];
        return absent.has(gate) ? [] : [gatedConstruct(construct, gate)];
      });
      if (kept.length > 0) map[code] = Array.isArray(entry) ? kept : kept[0];
    }
    result[field] = map;
  }
  return result as Extension;
}

type MdastExtensions = NonNullable<FromMarkdownOptions["mdastExtensions"]>;

// Merged once, as mdast-util-from-markdown merges them on every call: lists in order, handlers by key.
function mergeMdastExtensions(extensions: MdastExtensions): MdastExtension {
  const merged = {
    canContainEols: [] as string[],
    enter: {},
    exit: {},
    transforms: [] as Transform[],
  };
  for (const extension of extensions.flat()) {
    merged.canContainEols.push(...(extension.canContainEols ?? []));
    Object.assign(merged.enter, extension.enter);
    Object.assign(merged.exit, extension.exit);
    // GFM looks for autolink literals again in the decoded text outside links, so `www\.x.io`
    // links too. Most texts have URLs only in link destinations and code, where it finds nothing.
    for (const transform of extension.transforms ?? []) {
      merged.transforms.push(
        extension.enter?.literalAutolink
          ? (tree) => (hasAutolinkText(tree) ? transform(tree) : undefined)
          : transform,
      );
    }
  }
  return merged;
}

const AUTOLINK_TEXT = /@|https?:\/\/|www\./i;

function hasAutolinkText(node: MdastNodes): boolean {
  if (node.type === "text") return AUTOLINK_TEXT.test(node.value);
  if (node.type === "link" || node.type === "linkReference" || !("children" in node)) return false;
  return node.children.some(hasAutolinkText);
}

/**
 * Parses as remark-parse does, without the syntax extension constructs that cannot match the
 * text. Same tree, in about half the time.
 */
function attachParserWithoutUnusedSyntax(this: Processor) {
  const data = this.data();
  const byMask = new Map<number, FromMarkdownOptions["extensions"]>();
  let mdastExtensions: MdastExtension[] | undefined;
  this.parser = (document) => {
    let mask = 0;
    GATES.forEach((gate, index) => {
      if (!gate.inText(document)) mask |= 1 << index;
    });
    let extensions = byMask.get(mask);
    if (!extensions) {
      const absent = new Set(GATES.filter((_, index) => mask & (1 << index)));
      extensions = [
        combineExtensions(
          (data.micromarkExtensions ?? []).map((extension) => gateExtension(extension, absent)),
        ),
      ];
      byMask.set(mask, extensions);
    }
    mdastExtensions ??= [mergeMdastExtensions(data.fromMarkdownExtensions ?? [])];
    const outer = parsing;
    // Gates read micromark offsets, which skip a leading byte order mark.
    parsing = document.charCodeAt(0) === 0xfeff ? document.slice(1) : document;
    try {
      return fromMarkdown(document, { ...data.settings, extensions, mdastExtensions });
    } finally {
      parsing = outer;
    }
  };
}

export const remarkParseWithoutUnusedSyntax = attachParserWithoutUnusedSyntax;
