import { Extension } from "@tiptap/core";
import { type EditorState, Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";

import type { DiffThemeName } from "~/lib/diffRendering";
import { languageOfInfoString } from "~/composer-code-languages";
import { getSyntaxHighlighterPromise } from "~/lib/syntaxHighlighting";

interface HighlightedBlock {
  /** Guards against repainting a block whose text and language are unchanged. */
  readonly signature: string;
  readonly decorations: ReadonlyArray<{ from: number; to: number; color: string }>;
}

const composerCodeBlockHighlightKey = new PluginKey<DecorationSet>("composerCodeBlockHighlight");

/**
 * Past this many characters a fence is left plain. Tokenizing is synchronous
 * and covers the whole block: a few milliseconds for a couple of hundred lines,
 * but ~80ms at a thousand. 20k characters is roughly 400–500 lines of ordinary
 * code; a fence that shrinks back under it is highlighted again.
 */
export const MAX_HIGHLIGHTED_CODE_BLOCK_LENGTH = 20_000;

/**
 * Any edit changes a block's signature, so a fence would be re-tokenized on
 * every keystroke. Past this many characters (about 60 lines) that costs more
 * than a few milliseconds, and a frame by 150 lines, so while such a fence is
 * being typed in it keeps the colors it had, moved with its text, and is
 * re-tokenized once typing pauses. Shorter fences still repaint per keystroke.
 */
export const DEFERRED_HIGHLIGHT_CODE_BLOCK_LENGTH = 2_000;
/** How long typing pauses before a long fence is re-tokenized. */
export const DEFERRED_HIGHLIGHT_DELAY_MS = 300;

export function shouldHighlightCodeBlock(code: string): boolean {
  return code.length <= MAX_HIGHLIGHTED_CODE_BLOCK_LENGTH;
}
function blockSignature(node: ProseMirrorNode, theme: DiffThemeName): string {
  // A separator that cannot occur in a language name keeps the parts distinct.
  return [theme, String(node.attrs.language ?? ""), node.textContent].join("\u0000");
}

/**
 * The composer's code blocks, which are always top-level: list items and
 * quotes cannot hold one. Scanning only the top level keeps a keystroke in a
 * long draft from walking every node in it.
 */
function collectCodeBlocks(state: EditorState): Array<{ node: ProseMirrorNode; pos: number }> {
  const blocks: Array<{ node: ProseMirrorNode; pos: number }> = [];
  state.doc.forEach((node, pos) => {
    if (node.type.name === "codeBlock") blocks.push({ node, pos });
  });
  return blocks;
}

/**
 * Highlights composer code blocks with the same Shiki instance the chat view
 * uses, painted as inline decorations so the text nodes stay editable.
 *
 * Highlighting is asynchronous and per block: a keystroke re-tokenizes only the
 * block that changed, and only after its highlighter has resolved. Blocks whose
 * text and language are unchanged reuse their previous decorations, and a block
 * waiting to be re-tokenized keeps the ones it had.
 */
export function composerCodeBlockHighlight(options: {
  resolveTheme: () => DiffThemeName;
}): Extension {
  return Extension.create({
    name: "composerCodeBlockHighlight",

    addProseMirrorPlugins() {
      // Every keystroke in a code block mints a new signature, so each scan
      // drops the signatures the document no longer holds. The cache is then
      // bounded by the document itself, and no block it holds is ever evicted.
      const cache = new Map<string, HighlightedBlock>();
      // The latest scan's signatures, so a tokenize that resolves after its
      // block was edited away does not put it back.
      let live = new Set<string>();

      return [
        new Plugin<DecorationSet>({
          key: composerCodeBlockHighlightKey,

          state: {
            init: () => DecorationSet.empty,
            apply(transaction, value, _oldState, newState) {
              const mapped = value.map(transaction.mapping, transaction.doc);
              if (!transaction.docChanged && !transaction.getMeta(composerCodeBlockHighlightKey)) {
                return mapped;
              }
              return buildDecorations(newState, cache, options.resolveTheme(), mapped);
            },
          },

          props: {
            decorations(state) {
              return composerCodeBlockHighlightKey.getState(state);
            },
          },

          view(view) {
            let disposed = false;
            let paintedTheme = options.resolveTheme();
            let scannedDoc: ProseMirrorNode | null = null;
            let deferredRefresh: ReturnType<typeof setTimeout> | undefined;

            /**
             * Tokenizes any block missing from the cache, then repaints once.
             * Returning early when nothing is pending is what stops the
             * dispatch below from re-triggering this on its own update.
             * `deferLong` holds back the fences too long to tokenize per
             * keystroke until typing pauses.
             */
            const refresh = (deferLong: boolean) => {
              const theme = options.resolveTheme();
              const themeChanged = theme !== paintedTheme;
              paintedTheme = theme;
              // A selection change cannot alter what needs tokenizing, and
              // building a signature means concatenating every block's text.
              if (!themeChanged && view.state.doc === scannedDoc) return;
              clearTimeout(deferredRefresh);
              scannedDoc = view.state.doc;
              const blocks = collectCodeBlocks(view.state);
              live = new Set(blocks.map(({ node }) => blockSignature(node, theme)));
              for (const signature of cache.keys()) {
                if (!live.has(signature)) cache.delete(signature);
              }
              const missing = blocks.filter(
                ({ node }) =>
                  shouldHighlightCodeBlock(node.textContent) &&
                  !cache.has(blockSignature(node, theme)),
              );
              const pending = deferLong
                ? missing.filter(
                    ({ node }) => node.textContent.length <= DEFERRED_HIGHLIGHT_CODE_BLOCK_LENGTH,
                  )
                : missing;
              if (pending.length < missing.length) {
                deferredRefresh = setTimeout(() => {
                  scannedDoc = null;
                  refresh(false);
                }, DEFERRED_HIGHLIGHT_DELAY_MS);
              }
              if (pending.length === 0) {
                // A theme switch keeps every signature but changes which one
                // applies, so the painted decorations still have to be rebuilt.
                if (themeChanged) {
                  view.dispatch(view.state.tr.setMeta(composerCodeBlockHighlightKey, true));
                }
                return;
              }

              // Settled rather than all: a block whose highlighter fails to
              // load stays plain, and the others are still painted.
              void Promise.allSettled(
                pending.map(async ({ node }) => {
                  // The stored info string keeps everything after the language
                  // (`js title=x`); Shiki wants only the name.
                  const language =
                    languageOfInfoString(String(node.attrs.language ?? "")) || "text";
                  const signature = blockSignature(node, theme);
                  // A highlighter that fails to load leaves the block plain, held
                  // as a result so the colors it had before an edit do not stay.
                  const highlighter = await getSyntaxHighlighterPromise(language).catch(() => null);
                  if (disposed || cache.has(signature) || !live.has(signature)) return;
                  cache.set(signature, {
                    signature,
                    decorations: highlighter
                      ? tokenizeBlock(highlighter, node.textContent, language, theme)
                      : [],
                  });
                }),
              ).then(() => {
                if (disposed) return;
                view.dispatch(view.state.tr.setMeta(composerCodeBlockHighlightKey, true));
              });
            };

            refresh(false);
            // The theme lives on <html>, outside the editor, so nothing would
            // otherwise tell the view a repaint is due.
            const themeObserver = new MutationObserver(() => refresh(false));
            themeObserver.observe(document.documentElement, {
              attributeFilter: ["class"],
            });

            return {
              update: () => refresh(true),
              destroy() {
                disposed = true;
                clearTimeout(deferredRefresh);
                themeObserver.disconnect();
              },
            };
          },
        }),
      ];
    },
  });
}

type Highlighter = Awaited<ReturnType<typeof getSyntaxHighlighterPromise>>;

/** Flattens Shiki's line/token structure into offsets within the block's text. */
export function tokenizeBlock(
  highlighter: Highlighter,
  code: string,
  language: string,
  theme: DiffThemeName,
): ReadonlyArray<{ from: number; to: number; color: string }> {
  let tokens;
  try {
    tokens = highlighter.codeToTokens(code, { lang: language, theme }).tokens;
  } catch {
    // An unsupported language should read as plain text, not break the editor.
    return [];
  }

  const decorations: Array<{ from: number; to: number; color: string }> = [];
  let offset = 0;
  for (const [lineIndex, line] of tokens.entries()) {
    // The separator between lines, which Shiki drops; CRLF is two characters.
    if (lineIndex > 0) offset += code.startsWith("\r\n", offset) ? 2 : 1;
    for (const token of line) {
      const length = token.content.length;
      if (token.color && token.content.trim()) {
        decorations.push({ from: offset, to: offset + length, color: token.color });
      }
      offset += length;
    }
  }
  return decorations;
}

function buildDecorations(
  state: EditorState,
  cache: Map<string, HighlightedBlock>,
  theme: DiffThemeName,
  previous: DecorationSet,
): DecorationSet {
  const decorations: Decoration[] = [];
  for (const { node, pos } of collectCodeBlocks(state)) {
    if (!shouldHighlightCodeBlock(node.textContent)) continue;
    const highlighted = cache.get(blockSignature(node, theme));
    if (!highlighted) {
      // Edited and not yet re-tokenized: keep the colors the block had, which
      // the transaction has already moved along with its text. A token split
      // across two blocks would otherwise color both, and what lies between.
      const start = pos + 1;
      const end = start + node.content.size;
      for (const decoration of previous.find(start, end)) {
        if (decoration.from >= start && decoration.to <= end) {
          decorations.push(decoration);
          continue;
        }
        const from = Math.max(decoration.from, start);
        const to = Math.min(decoration.to, end);
        if (from < to) decorations.push(colorDecoration(from, to, decoration.spec.color));
      }
      continue;
    }
    // Token offsets index the block's text, which lines up with document
    // positions only because `codeBlock` is `text*` with no marks — one
    // unmarked text node, so `content.size === textContent.length`. Allowing
    // marks or hard breaks in the code block would desync these silently.
    if (node.content.size !== node.textContent.length) continue;
    // +1 steps past the code block's opening token into its text.
    const start = pos + 1;
    for (const decoration of highlighted.decorations) {
      decorations.push(
        colorDecoration(start + decoration.from, start + decoration.to, decoration.color),
      );
    }
  }
  return DecorationSet.create(state.doc, decorations);
}

/** The color rides in the spec too, so a kept decoration can be cut to its block. */
function colorDecoration(from: number, to: number, color: string): Decoration {
  return Decoration.inline(from, to, { style: `color:${color}` }, { color });
}
