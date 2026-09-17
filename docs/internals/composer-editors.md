# Composer editors

> For maintainers. Using T3 Code? The composer is the message box; its settings live under
> Settings → General.

The composer is a single Tiptap surface with two modes. The
`composerRichTextEnabled` client setting toggles styling, never the engine:
rich mode renders `**bold**`, `*italic*`, `` `code` ``, `~~strike~~`, and
`- [ ]` task checkboxes, while plain mode disables the mark extensions and
task detection so every marker stays a literal character.

## The contract both modes share

- The draft store owns the prompt as Markdown text. Either mode must serialize to the
  identical string for the same document: same markers, same canonical chip sources, same
  newlines. `ComposerPromptEditor` is a thin wrapper over the Tiptap surface; flipping the
  setting remounts the editor (extensions are creation-time) and both halves initialize from
  the controlled value, so the draft survives the flip.
- Cursors speak the store's collapsed/expanded coordinates, not editor positions. A collapsed
  cursor counts every inline chip as one character; the expanded cursor counts its full source.
  `composer-rich-text-doc.ts` maps between ProseMirror positions and both coordinates. Tests
  round-trip Markdown through a real ProseMirror document in Node (`composer-rich-text-doc.test.ts`)
  precisely so this invariant holds without a browser.
- Chips (mentions, skills, citations, context references) are Tiptap inline atoms. Arrow keys step over them, Backspace removes the whole chip, and copy
  carries the structured context fragment beside the plain text. Surround-typing inserts pairs
  around plain selections only: it refuses chips, styled text, and mention boundaries.

## Marker reveal

Rich-text markers are never edited, only shown. The document holds the inner text with a mark;
a ProseMirror plugin draws the delimiters as non-editable widgets while the selection touches
the styled range, and cursor offsets landing on marker characters clamp to the styled edge.
Typing the markers still works: Tiptap's mark input rules convert `**bold**` to a bold mark on
close, and serialization writes the markers back.

## Newlines are paragraph splits

Newlines the parent declines (Shift+Enter, or Enter while the send shortcut says otherwise) split
the paragraph. Letting them fall through would insert a native trailing `<br>`, which renders no
visible line, so the caret would look stuck until a second press. Pasted multiline text builds
paragraphs for the same reason.

## Lists

List continuation lives one level up, in ChatComposer's command key handler, as a store
replacement (`composer-list-continuation.ts`): Enter on a `-`, `*`, `+`, `1.`/`1)`, or `- [ ]`
item continues it on the next line, Enter on an empty item exits the list, and Tab indents by
two spaces. Running it above the editor as a store replacement keeps both modes'
behavior and their serialized Markdown
identical. Carets inside the marker or inside an inline chip fall through to a plain newline so
a split can never corrupt either.

## Task lists

`- [ ]` / `- [x]` lines become real Tiptap task items with clickable checkboxes;
everything else (ordered/plain bullets) stays plain text. Toggling a checkbox
rewrites the marker in the stored Markdown. Consecutive task lines group into
nested lists by indent prefix, and the exact source indent is kept in an
attribute so nesting round-trips byte-identically. Uppercase `[X]` normalizes
to `[x]` — the same fixed-point deal as `__bold__` becoming `**bold**`. Enter
on a focused checkbox does nothing (Space toggles it); list continuation still
runs above the editor via the store, so behavior matches the plain mode.

## The view follows the caret

Native scrolling only follows real input, so every programmatic caret move —
paragraph splits, controlled rewrites, paste inserts, focus restores — scrolls
the composer to the caret explicitly (`scrollIntoView` on the Tiptap
transaction, a caret-element scroll in the same editor). Mashing Enter
stays glued to the cursor.
