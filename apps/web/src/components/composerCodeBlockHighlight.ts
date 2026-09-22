import { Extension } from "@tiptap/core";
import { type EditorState, Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";

import type { DiffThemeName } from "~/lib/diffRendering";
import { getSyntaxHighlighterPromise } from "~/lib/syntaxHighlighting";

interface HighlightedBlock {
  /** Guards against repainting a block whose text and language are unchanged. */
  readonly signature: string;
  readonly decorations: ReadonlyArray<{ from: number; to: number; color: string }>;
}

const composerCodeBlockHighlightKey = new PluginKey<DecorationSet>("composerCodeBlockHighlight");

const MAX_CACHED_BLOCKS = 64;
/**
 * Bounded so a long session cannot grow the set without limit, but far above
 * the number of fences any composer prompt realistically holds. This set alone
 * only raises the threshold at which repeated eviction would keep work looking
 * pending; the unconditional loop breaker is the `scannedDoc` check below.
 */
const MAX_ATTEMPTED_SIGNATURES = 2048;

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
      // Every keystroke in a code block mints a new signature, so the cache is
      // bounded and evicts oldest-first rather than growing with the session.
      const cache = new Map<string, HighlightedBlock>();
      // Which signatures have been tokenized, whether or not their decorations
      // survived eviction. Without this, a document with more blocks than the
      // cache holds would always report work as pending: each pass would evict
      // the entries the previous pass added, and the repaint would never settle.
      const attempted = new Set<string>();
      const rememberAttempt = (signature: string) => {
        attempted.add(signature);
        // Generous next to the decoration cache so a large document still
        // settles, but bounded so a long editing session cannot grow it without
        // limit. Eviction here can only cost a re-tokenize, never a loop.
        while (attempted.size > MAX_ATTEMPTED_SIGNATURES) {
          const oldest = attempted.values().next();
          if (oldest.done) break;
          attempted.delete(oldest.value);
        }
      };
      const remember = (signature: string, block: HighlightedBlock) => {
        cache.set(signature, block);
        while (cache.size > MAX_CACHED_BLOCKS) {
          const oldest = cache.keys().next();
          if (oldest.done) break;
          cache.delete(oldest.value);
        }
      };

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
              const pending = collectCodeBlocks(view.state).filter(
                ({ node }) => !attempted.has(blockSignature(node, theme)),
              );
              if (pending.length === 0) {
                // A theme switch keeps every signature but changes which one
                // applies, so the painted decorations still have to be rebuilt.
                if (themeChanged) {
                  view.dispatch(view.state.tr.setMeta(composerCodeBlockHighlightKey, true));
                }
                return;
              }

              void Promise.all(
                pending.map(async ({ node }) => {
                  // The stored info string keeps its whitespace; Shiki wants the name.
                  const language = String(node.attrs.language ?? "").trim() || "text";
                  const signature = blockSignature(node, theme);
                  const highlighter = await getSyntaxHighlighterPromise(language);
                  if (disposed) return;
                  rememberAttempt(signature);
                  if (cache.has(signature)) return;
                  remember(signature, {
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
    if (lineIndex > 0) offset += 1; // the newline between lines
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
