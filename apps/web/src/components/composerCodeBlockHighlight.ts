import { Extension } from "@tiptap/core";
import { type EditorState, Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";

import type { DiffThemeName } from "~/lib/diffRendering";
import { languageOfInfoString } from "~/composer-code-languages";
import { getSyntaxHighlighterPromise } from "~/lib/syntaxHighlighting";

interface HighlightedBlock {
  readonly signature: string;
  readonly decorations: ReadonlyArray<{ from: number; to: number; color: string }>;
}

const composerCodeBlockHighlightKey = new PluginKey<DecorationSet>("composerCodeBlockHighlight");

// Tokenizing larger fences can stall the main thread.
const MAX_HIGHLIGHTED_CODE_BLOCK_LENGTH = 20_000;

// Keep mapped colors while typing in long fences, then refresh after a pause.
const DEFERRED_HIGHLIGHT_CODE_BLOCK_LENGTH = 2_000;
const DEFERRED_HIGHLIGHT_DELAY_MS = 300;

function shouldHighlightCodeBlock(code: string): boolean {
  return code.length <= MAX_HIGHLIGHTED_CODE_BLOCK_LENGTH;
}
function blockSignature(node: ProseMirrorNode, theme: DiffThemeName): string {
  return [theme, String(node.attrs.language ?? ""), node.textContent].join("\u0000");
}

/** Code blocks are always top-level; avoid walking the whole draft per keystroke. */
function collectCodeBlocks(state: EditorState): Array<{ node: ProseMirrorNode; pos: number }> {
  const blocks: Array<{ node: ProseMirrorNode; pos: number }> = [];
  state.doc.forEach((node, pos) => {
    if (node.type.name === "codeBlock") blocks.push({ node, pos });
  });
  return blocks;
}

export function composerCodeBlockHighlight(options: {
  resolveTheme: () => DiffThemeName;
}): Extension {
  return Extension.create({
    name: "composerCodeBlockHighlight",

    addProseMirrorPlugins() {
      // Prune obsolete signatures each scan so the cache is bounded by the document without evicting live
      // blocks.
      const cache = new Map<string, HighlightedBlock>();
      // Track live signatures so late tokenization cannot restore edited-away blocks.
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

            // Repaint dispatches and selection changes must not restart the debounce.
            const refresh = (deferLong: boolean) => {
              const theme = options.resolveTheme();
              const themeChanged = theme !== paintedTheme;
              paintedTheme = theme;
              // Selection changes cannot affect tokens; avoid rebuilding every block's text signature.
              if (!themeChanged && view.state.doc === scannedDoc) return;
              clearTimeout(deferredRefresh);
              scannedDoc = view.state.doc;
              const blocks = collectCodeBlocks(view.state);
              const signatures = new Set(blocks.map(({ node }) => blockSignature(node, theme)));
              live = signatures;
              for (const signature of cache.keys()) {
                if (!live.has(signature)) cache.delete(signature);
              }
              const missing = blocks.filter(
                ({ node }) =>
                  shouldHighlightCodeBlock(node.textContent) &&
                  !cache.has(blockSignature(node, theme)),
              );
              const pending =
                deferLong && !themeChanged
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
                if (themeChanged) {
                  view.dispatch(view.state.tr.setMeta(composerCodeBlockHighlightKey, true));
                }
                return;
              }

              void Promise.allSettled(
                pending.map(async ({ node }) => {
                  // Stored info includes metadata after the language; Shiki needs only the name.
                  const language =
                    languageOfInfoString(String(node.attrs.language ?? "")) || "text";
                  const signature = blockSignature(node, theme);
                  // Cache failure as plain text to clear retained colors.
                  const highlighter = await getSyntaxHighlighterPromise(language).catch(() => null);
                  // An older request must not bypass the debounce if its text returns.
                  if (disposed || live !== signatures || cache.has(signature)) return;
                  cache.set(signature, {
                    signature,
                    decorations: highlighter
                      ? tokenizeBlock(highlighter, node.textContent, language, theme)
                      : [],
                  });
                }),
              ).then(() => {
                if (disposed || live !== signatures) return;
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
      // A mapped token can span split fences and the paragraph between them.
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
    const start = pos + 1;
    for (const decoration of highlighted.decorations) {
      decorations.push(
        colorDecoration(start + decoration.from, start + decoration.to, decoration.color),
      );
    }
  }
  return DecorationSet.create(state.doc, decorations);
}

// Keep the color available when clipping mapped decorations to a fence.
function colorDecoration(from: number, to: number, color: string): Decoration {
  return Decoration.inline(from, to, { style: `color:${color}` }, { color });
}
