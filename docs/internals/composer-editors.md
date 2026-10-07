# Composer coordinates and serialization

The draft store owns Markdown, while Tiptap owns the editing document. The rich-text
setting changes the installed extensions, so toggling it remounts the editor from the
stored draft. Plain mode must leave formatting markers literal. Rich mode preserves
whitespace and chip sources, but canonicalizes supported delimiters (`__` to `**`,
`_` to `*`) and checkbox case (`[X]` to `[x]`).

Store cursors are not ProseMirror positions: collapsed coordinates count a chip as one
character, expanded coordinates count its source text, and ProseMirror also counts
block boundaries. Keep conversion in [the document model](../../apps/web/src/composer-rich-text-doc.ts).
Empty paragraphs need real caret positions even though they contain no text. Markers
shown beside styled text are decorations, so offsets inside them clamp to the text edge.

Only replace editor content when the controlled text changes. Replacing it for a cursor
move creates undo entries and regenerates citation identities. Pending citation popovers
must wait until the requested draft has reached the editor before locating their chip.

Rich tasks split through native editor commands so marks and chips survive. Literal
lists use [store edits](../../apps/web/src/composer-list-continuation.ts). Newlines become
paragraph splits: trailing hard breaks otherwise appear to require two presses.
Programmatic moves must explicitly scroll the caret into view.

Clipboard text must come from the Markdown serializer, not DOM text: chip labels omit
the source and marker decorations are not content. Structured context records accompany
that text when available. Paste completes trailing chip delimiters and adds a leading
boundary when inserting a chip directly after text.

The `composer.toggleRichText` shortcut remounts the editor, which drops focus.
The restore is signalled by the shortcut rather than derived from the setting,
because a flag set during render never reaches the child React mounts in that
render. It waits for the `useEditor` instance, which arrives in an effect and
can be rebuilt once more, and places the caret with ProseMirror's `view.focus()`.
A raw DOM focus leaves the DOM selection at the start, and the first chip node
view to mount then resets the caret to 0.
