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
 * Past this many characters a fence is left plain. Any edit changes a block's
 * signature, so each keystroke re-tokenizes the whole block synchronously on
 * the main thread: a few milliseconds for a couple of hundred lines, but ~80ms
 * at a thousand, which stalls typing. 20k characters is roughly 400–500 lines
 * of ordinary code; a fence that shrinks back under it is highlighted again.
 */
export const MAX_HIGHLIGHTED_CODE_BLOCK_LENGTH = 20_000;

export function shouldHighlightCodeBlock(code: string): boolean {
  return code.length <= MAX_HIGHLIGHTED_CODE_BLOCK_LENGTH;
}
function blockSignature(node: ProseMirrorNode, theme: DiffThemeName): string {
  // A separator that cannot occur in a language name keeps the parts distinct.
  return [theme, String(node.attrs.language ?? ""), node.textContent].join("\u0000");
}

function collectCodeBlocks(state: EditorState): Array<{ node: ProseMirrorNode; pos: number }> {
  const blocks: Array<{ node: ProseMirrorNode; pos: number }> = [];
  state.doc.descendants((node, pos) => {
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
 * text and language are unchanged reuse their previous decorations.
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
              if (!transaction.docChanged && !transaction.getMeta(composerCodeBlockHighlightKey)) {
                return value.map(transaction.mapping, transaction.doc);
              }
              return buildDecorations(newState, cache, options.resolveTheme());
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

            /**
             * Tokenizes any block missing from the cache, then repaints once.
             * Returning early when nothing is pending is what stops the
             * dispatch below from re-triggering this on its own update.
             */
            const refresh = () => {
              const theme = options.resolveTheme();
              const themeChanged = theme !== paintedTheme;
              paintedTheme = theme;
              // A selection change cannot alter what needs tokenizing, and
              // building a signature means concatenating every block's text.
              if (!themeChanged && view.state.doc === scannedDoc) return;
              scannedDoc = view.state.doc;
              const blocks = collectCodeBlocks(view.state);
              live = new Set(blocks.map(({ node }) => blockSignature(node, theme)));
              for (const signature of cache.keys()) {
                if (!live.has(signature)) cache.delete(signature);
              }
              const pending = blocks.filter(
                ({ node }) =>
                  shouldHighlightCodeBlock(node.textContent) &&
                  !cache.has(blockSignature(node, theme)),
              );
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
                  const highlighter = await getSyntaxHighlighterPromise(language);
                  if (disposed || cache.has(signature) || !live.has(signature)) return;
                  cache.set(signature, {
                    signature,
                    decorations: tokenizeBlock(highlighter, node.textContent, language, theme),
                  });
                }),
              ).then(() => {
                if (disposed) return;
                view.dispatch(view.state.tr.setMeta(composerCodeBlockHighlightKey, true));
              });
            };

            refresh();
            // The theme lives on <html>, outside the editor, so nothing would
            // otherwise tell the view a repaint is due.
            const themeObserver = new MutationObserver(refresh);
            themeObserver.observe(document.documentElement, {
              attributeFilter: ["class"],
            });

            return {
              update: refresh,
              destroy() {
                disposed = true;
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
): DecorationSet {
  const decorations: Decoration[] = [];
  for (const { node, pos } of collectCodeBlocks(state)) {
    if (!shouldHighlightCodeBlock(node.textContent)) continue;
    const highlighted = cache.get(blockSignature(node, theme));
    if (!highlighted) continue;
    // Token offsets index the block's text, which lines up with document
    // positions only because `codeBlock` is `text*` with no marks — one
    // unmarked text node, so `content.size === textContent.length`. Allowing
    // marks or hard breaks in the code block would desync these silently.
    if (node.content.size !== node.textContent.length) continue;
    // +1 steps past the code block's opening token into its text.
    const start = pos + 1;
    for (const decoration of highlighted.decorations) {
      decorations.push(
        Decoration.inline(start + decoration.from, start + decoration.to, {
          style: `color:${decoration.color}`,
        }),
      );
    }
  }
  return DecorationSet.create(state.doc, decorations);
}
