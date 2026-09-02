# Assistant citations

> For maintainers. Using T3 Code? See [Quote an assistant response](../user/composer.md#quote-an-assistant-response).

Assistant citations store a selected excerpt and its source in ordinary message text. They need
no database migration, citation table, or sidecar draft metadata. The saved excerpt remains
available even when the source response is missing or has changed.

## Serialized form

[`AssistantCitation`][contract] defines version 1. [`assistantCitations.ts`][shared] serializes it
as a Markdown link with the literal label `Assistant quote`:

```text
[Assistant quote](t3-citation://v1/<environmentId>/<threadId>/<messageId>?text=<quote>&start=<start>&end=<end>&prefix=<prefix>&suffix=<suffix>&comment=<optional-user-comment>)
```

The formatter percent-encodes each path segment and uses `URLSearchParams` for the query. The
environment, thread, and message IDs identify the source without a browser origin, so local,
remote, and tunnel clients share one form. Opening the source still requires access to its
environment.

The parser accepts only version 1 with exactly three source IDs and one of each selector field;
`comment` is optional and links without one keep their original format. It rejects credentials,
ports, malformed encoding, and extra or duplicate query fields. IDs have a 512-character limit,
the quote and comment each fit in 8,000 UTF-16 code units, offsets are nonnegative safe integers
with `end > start`, prefix and suffix each fit in 32 code units, and the URI itself is capped at
160,000 characters. Malformed or unsupported links remain ordinary prompt text everywhere:
collectors, provider expansion, and readable fallbacks all skip them. Parsing validates the
payload, not the existence of its source.

## Selection and source matching

[`assistantTextSelection.ts`][selection] captures one native DOM range inside one assistant
response, including backward and paragraph selections. Empty range endpoints at neighboring blocks
are narrowed to the first and last selected text nodes before validating the source, so
triple-click selections that end at the next block still resolve. The text stream follows DOM
order, inserts line breaks between blocks and at `<br>`, and includes displayed code and link
text. Controls, hidden subtrees, CSS-generated content, and soft wrapping do not contribute.

`text` keeps the exact selected excerpt, including line breaks and indentation. `start`, `end`,
`prefix`, and `suffix` use the rendered-text stream after each JavaScript whitespace run collapses
to one space, without trimming, in UTF-16 code units. Context boundaries avoid splitting
surrogate pairs.

Resolution uses the same normalization and case-sensitive matching. It checks the saved offsets
against the quote and context, then searches for a context-matching occurrence if positions have
moved. A unique quote can still match after its context changes. Multiple context-matching
occurrences are ambiguous, even if one remains at the saved offsets; the resolver does not guess.

## Composer and clients

[`AssistantSelectionToolbar`][toolbar] offers **Cite in composer** for a selection within one
response and disables it above the quote limit. It shares [`selectionActions.ts`][actions] with
the terminal's selection menu: the observer opens actions only after a primary-button release from
a gesture that started inside the surface, waits out the 500 ms repeat-click window so
double/triple clicks can finish, anchors to the release point (or the text end for keyboard
selections), and dismisses on outside interaction, scrolling, or `Escape`. The toolbar registers
its own element with the observer so interacting with it cannot replace the captured quote.

`ChatView` inserts the serialized link at the last composer cursor. A one-shot editor request then
opens the comment editor beside the cited source text, carrying the live DOM range for positioning
and an editing highlight; that range is transient and never becomes part of the citation.
`withAssistantCitationComment` trims outer whitespace and removes the field when blank; it never
changes the saved quote or selector. Restoring or pasting a citation does not reopen the editor.

[`ComposerCitationNode`][node] is an inline Lexical `DecoratorNode` holding the quote and comment
as one atomic chip. Its label shows the comment when present, otherwise a short quote preview; the
node retains the full serialized source and returns it from `getTextContent()`. Comment edits
update the citation and serialized source together as one undoable change. The token parser,
clipboard handling, and cursor mapping treat citations as inline tokens alongside mentions and
skills, so drafts, stashes, and pastes reconstruct chips from the prompt string alone. Sent
messages keep the same links; `ChatMarkdown` renders valid citation URIs as read-only
[`AssistantCitationChip`][chip]s, and the whole chip supplies its serialized value to Markdown
copy so the displayed label is not duplicated as text.

## Source navigation

[`assistantCitationNavigation.ts`][navigation] routes to the source thread with
`#assistant-citation=<base64url-encoded citation URI>`; the encoding keeps router hash
normalization from decoding quote whitespace or source IDs. Each click adds a fresh activation ID
to navigation state so the same link can reveal its source again after dismissal.

[`useAssistantCitationTarget`][target] loads earlier history (bounded at 20 pages or a repeated
cursor, with a warning past that), expands a folded turn, and asks the virtual list to mount the
source row. While positioning, the timeline disables initial end-scroll and scroll maintenance and
keeps the cited row mounted until measured; the activation ID doubles as the list's data version
so pinning rows recalculates a stationary Legend list without discarding measurements.

[`AssistantCitationSource`][source] resolves the DOM range, smoothly scrolls to it, and pulses
only that text through the CSS Highlight API: two 650 ms pulses driven by a registered opacity
property, with the second settling into a held highlight before fading out. Navigation owns the
highlight's start time and completion state: range repairs keep the original clock, remounting
resumes only the remaining time, and an expired or dismissed highlight cannot revive. Reduced
motion scrolls instantly and holds the highlight without pulsing. Browsers
without the Highlight API temporarily select the range and remove only that owned selection.
User navigation or `Escape` cancels pending positioning; missing messages or unmatched text
produce warnings without changing the saved quote. The separate comment-editing highlight uses
the same range-repair observer while its editor is open.

Desktop shares the web implementation. Mobile's `ThreadFeed` uses `renderAssistantCitationsAsText`
to show sent quotes as readable Markdown blockquotes with each user comment below its quote; it
does not create citations or navigate to sources.

## Provider input and titles

[`ProviderService.sendTurn`][provider] calls `expandAssistantCitationsForProvider` before routing
to any adapter; persisted messages keep their links. Each distinct serialized link becomes an
inline `[assistant-quote-N]` marker, and one `<assistant_citations>` block carries JSON entries
with an `id` and the complete `citation`. The block identifies `citation.text` as quoted reference
material, not new instructions, and `citation.comment` as the user's comment about that quote.
JSON encoding escapes `<`, `>`, and `&` so content cannot close the wrapper. The expansion is
shared by all providers; there is no per-adapter citation handling or source lookup at send time.

The 120,000-character provider input limit applies both before and after expansion:
[`composerSubmission.ts`][submission] checks the larger length client-side and keeps an over-limit
draft editable, and the server revalidates the expanded input before dispatch. Expansion does not
apply to pending user-input answers.

`assistantCitationsToPlainText` supplies readable input for title seeds, stash previews, and the
server's title and branch-name helpers, which see the quoted text and comment rather than an
encoded URI.

[contract]: ../../packages/contracts/src/assistantCitations.ts
[shared]: ../../packages/shared/src/assistantCitations.ts
[selection]: ../../apps/web/src/lib/assistantTextSelection.ts
[toolbar]: ../../apps/web/src/components/chat/AssistantSelectionToolbar.tsx
[actions]: ../../apps/web/src/lib/selectionActions.ts
[node]: ../../apps/web/src/components/ComposerCitationNode.tsx
[chip]: ../../apps/web/src/components/chat/AssistantCitationChip.tsx
[navigation]: ../../apps/web/src/lib/assistantCitationNavigation.ts
[target]: ../../apps/web/src/components/chat/useAssistantCitationTarget.ts
[source]: ../../apps/web/src/components/chat/AssistantCitationSource.tsx
[provider]: ../../apps/server/src/provider/Layers/ProviderService.ts
[submission]: ../../apps/web/src/components/chat/composerSubmission.ts
