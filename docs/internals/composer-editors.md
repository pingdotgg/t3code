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

Bullet and ordered lists are real list nodes, but their items keep the exact
source marker (`marker`: `-`, `*`, `+`, `3.`, `3)`), the whitespace after it and
the leading indent as attributes, so a list round-trips byte-identically and is
never renumbered. The line grammar is the one the plain-mode continuation in
[composer-list-continuation](../../apps/web/src/composer-list-continuation.ts)
uses, so both modes agree on what a list line is; keep them in step. Items of a
different kind or marker at the same indent start a sibling list, which is what
lets `* a` under `- b` keep its star and a task list follow a bullet list.

Enter semantics are unchanged by rendering: `composerSubmissionIntentForEnter`
has no list flag and runs first, so Enter sends and it is Shift+Enter that
reaches the list branch. Rendered items split natively there (marks and chips
survive), ordered items counting up the way the literal continuation does; Tab
still goes through the literal store edit, which the rebuilt document reads back
as nesting. The dash bullet rule waits for the first character after `- ` and carries
it into the item, so the GFM task gesture `- [ ] ` is typed whole and reaches
the task rule; `*` and `+` convert on the space, since they are not task
markers here. `[ ] ` inside an existing bullet converts it as well.

A quote is a `blockquote` node carrying the exact `>` prefix of its lines as an
attribute, applied to every child paragraph on the way out; one source line is
one paragraph, and a line whose prefix differs starts a sibling quote, the same
rule lists use for a marker change. Lists and nested quotes are not parsed
inside a quote and the list input rules refuse to fire there: a quote holds
prose lines, and the serializer would have nowhere to put anything else.

A thematic break is a `horizontalRule` node carrying its exact source line. The
parser tries it before lists and before inline parsing, which is what keeps
`- - -` from becoming a bullet and `***` from becoming an empty bold span. It
owns no document characters, so offsets inside its source clamp to whatever
follows; a draft that ends on a rule has no caret position after it, which the
input rule avoids by inserting through `setHorizontalRule`, which appends a
paragraph when nothing follows.

A heading is a `heading` node whose `space` attribute keeps the exact
whitespace after the `#`s; closing `#`s stay literal text. The `#`s must be
followed by whitespace, in the parser and in the input rule alike. That is the
whole of the coexistence with pull request references: `detectComposerTrigger`
matches `#` followed immediately by word characters as a token, and a heading
needs the space that ends that token, so neither can ever claim the other's
input. Headings, rules and quotes form only at a top-level paragraph; the list
and quote serializers write paragraphs and lists and nothing else.

Fenced code blocks are real `codeBlock` nodes rather than literal text. They keep
their exact delimiters in attributes — `fence`, `language` and `close` — so a
fence round-trips byte-identically, including tilde fences, long fences and a
fence the user has not closed yet. Neither delimiter owns a document character,
so fence offsets clamp to the edge of the code the same way checkbox and style
markers do. The end of the code is the one place fences and inline marks differ:
the end of `**bold**` maps after its markers, but the end of a fence stays inside
the block, because its closing fence is a line of its own and "after it" would
move the caret to another line. The one normalization is an empty block written
with a blank line.

Fence delimiters are not marker decorations: the block is drawn as a block. Fence
runs carry `nodeName: "codeBlock"` and the marker plugin skips them. The node view
reuses the chat view's code block markup and class names so a draft looks like the
message it becomes; the shared rules in `index.css` are widened to both surfaces
rather than restated.

Enter reaches the fence before it reaches the send handler. Enter sends by
default, so checking the fence afterwards means a fence never opens and a
newline inside one sends the draft instead. Cmd/Ctrl+Enter still falls through
to send, which is the way out of a fence.

Fence editing lives in [composer-code-block](../../apps/web/src/composer-code-block.ts):
Enter keeps the current indent, Tab shifts whole lines, and two trailing blank
lines exit the block, which is the only way out of a fence at the end of a prompt.
Highlighting is Shiki decorations over the editable text, per block and cached by
content, so a keystroke re-tokenizes only the block that changed.

The `composer.toggleRichText` shortcut is not a second editor. It writes `composerRichTextEnabled`,
which remounts the same engine with the mark extensions off, so the draft and its
chips survive the flip. The surface does not change font: plain mode is the same
prose the user was already looking at, minus the styling.

The caret survives it too. A collapsed cursor means the same offset in both modes,
because markers are literal characters in the stored value either way, so the
remounted editor restores it from the stored cursor. Two traps sit in the way.
The flip has to be signalled by the shortcut handler rather than derived from
the setting: adjusting state during render makes React discard that render
pass including its children, so a flag computed that way never reaches the
editor being mounted, and flipping the setting from Settings should not pull
focus into the composer anyway. And `useEditor` returns null on its first render
and builds the instance in an effect, then can rebuild it once more right after,
which replaces the focused DOM node and drops focus to the body. So the restore
waits for the instance and applies to whichever instance is current, not only
the first; a one-shot guard restores into an editor that is about to be thrown
away. Placing the caret must end with ProseMirror's own `view.focus()`, not the
DOM's: only that writes the selection into the DOM. Left unsynced, the first chip
node view to mount makes ProseMirror re-read the DOM selection from the start,
which moves the caret and reports a cursor of 0 to the store — so a draft with
a chip lost its caret while plain prose kept it. A caret that was sitting between two markers has no
position in rich mode and clamps to the styled text, which moves it by a marker's
width at most.
