# Composer context references

> For maintainers. Using T3 Code? See [docs/user](../user/).

Inline context references let a user message point at a typed payload from an exact position in
its prose: an image, a file, a terminal excerpt, a picked page element, a preview annotation, a
review comment, a file mention, or a skill. This document covers the wire contract and the pure
codecs. Editor, rendering, and clipboard behaviour land in later PRs and get their own sections
here as they arrive.

## Two linked concepts

- A **context record** is the payload. It lives in `message.context.records`, keyed by a
  `contextId`. Records never contain bytes: image and file records bind to an existing
  `ChatAttachment` by id.
- A **context reference** is one occurrence in the document. It is a Markdown link in
  `message.text` that carries only the kind and the `contextId`. Two references can point at one
  record. A reference's label is display text and never identity.

[`composerContext.ts`][contract] defines version 1 of the record union. Every record has
`version`, `contextId`, `kind`, and `label`, plus kind-specific fields with bounded lengths. The
union is open: a kind this build does not know decodes to `UnknownContextRecord` with its
`payload` preserved, and known kinds are excluded from that member so a malformed image record
fails its own schema rather than sliding through unchecked. `OrchestrationMessageContext` wraps
the records with `ForwardCompatibleArray`, so one undecodable record is dropped instead of failing
the whole message. The field is optional on `OrchestrationMessage`, both turn-start commands, and
`ThreadMessageSentPayload`. The decider and projector carry it through untouched.

## Identity namespaces

- `ComposerContextId`: durable payload identity. Branded. Values match `[a-z0-9_-]+` and do not
  require a `ctx_` prefix.
- `ComposerContextReferenceId` (`ref_…`): one document occurrence. Branded. Lives in editor state,
  not on the wire and is regenerated when canonical Markdown is reparsed.
- `ChatAttachmentId`: the existing server-owned attachment resource. A record's `attachmentId` is
  a binding, not the chip's identity, so upload normalization can rename the resource without
  rewriting references.

Clients mint context and reference ids. Shared code does not, because the Effect lint plugin
rejects direct `crypto.randomUUID()` there.

## Canonical reference syntax

[`composerContextReferences.ts`][shared] owns the grammar:

```text
[label](t3-context://v1/<kind>/<contextId>)
![label](t3-context://v1/image/<contextId>)
```

The parser accepts exactly the `t3-context:` scheme, the `v1` host, one kind segment matching
`[a-z][a-z0-9-]{0,39}`, and one id segment matching `[a-z0-9_-]{1,128}` case-insensitively. Query
strings, fragments, credentials, and extra segments are rejected. Labels are sanitized to survive
a Markdown link (no brackets or line breaks, at most 200 characters, never empty). Links that fail
to parse are ordinary text. `collectComposerInlineTokens` already rejects URI schemes for file
links, so a context link is never mistaken for a mention.

## Provider projection

`projectComposerContextForProvider({ text, records })` builds what the provider reads:

1. Every reference becomes an in-place marker: `[Image: shot.png; ref=ctx_1]`.
2. A trailing `<t3_context version="1">` envelope holds one `<context kind id>` entry per unique
   referenced id, in first-reference order. Records that are never referenced are not emitted.
   A referenced id with no record becomes `<context … unavailable="true"/>`. Mention and skill
   records produce a marker but no entry. Unknown kinds emit their payload as JSON.
3. Captured text is data: any `<` that would open or close `t3_context` or `context` is escaped,
   so a terminal line or PR comment cannot forge a record.

Attachment bytes travel on the existing attachment channel; the envelope only carries metadata.
Text without references is returned unchanged.

## Legacy messages

Messages sent before this feature carry trailing `<terminal_context>`, `<element_context>`, and
`<preview_annotation>` blocks, `<review_comment>` blocks, and U+FFFC terminal placeholders.
[`composerContextLegacy.ts`][legacy] upgrades them in memory:

- Review blocks become references in place. Blocks that trailed the original text are appended
  last, matching the old send order.
- Trailing blocks peel off the end in reverse send order (preview, element, terminal).
- Placeholders bind to terminal entries in order; entries without a placeholder are appended.
- Ids are deterministic (`legacy_<kind>_<n>`) so re-running the upgrade is idempotent.

Event history is never rewritten. Existing web parsers in `apps/web/src/lib/` stay until the
transcript renderer moves to records.

[contract]: ../../packages/contracts/src/composerContext.ts
[shared]: ../../packages/shared/src/composerContextReferences.ts
[legacy]: ../../packages/shared/src/composerContextLegacy.ts

## Editor model (web and desktop)

`ComposerContextReferenceNode` (`apps/web/src/components/ComposerContextReferenceNode.tsx`) is
the one inline Lexical node for every context kind. It stores `kind`, `contextId`, `label`, and a
per-occurrence `referenceId`, and its text content is the canonical link. The prompt string carries
payload identity and position, so rebuilding the editor restores equivalent chips; it does not
preserve the editor-local occurrence ids. Old drafts that used the U+FFFC ordinal placeholder
migrate on hydration: placeholders bind to the terminal contexts in array order, then any context
the prompt does not mention is prepended as a link.

Records stay in the draft store's typed arrays for now. The editor builds a `Map` keyed by
`contextId` from them (`composerContextRecordsFromDraft`) and provides it through
`ComposerContextRecordsContext`. `ComposerContextReferenceChip` looks the record up and renders
the kind's chip; an unknown kind or a missing record renders the unresolved chip instead of
vanishing. Removing a chip removes only that occurrence; the composer's change handler compares
the referenced ids against the draft array and drops records no chip points at.

Version 1 deliberately keeps kind presentation explicit in each client instead of exposing a
runtime handler registry. The contract and codecs are shared; web/desktop render rich chips and
mobile renders the readable label. Add a registry only when a third-party or runtime-defined kind
must provide behaviour that cannot ship with the client. Likewise, a durable occurrence id belongs
in the canonical reference syntax only if a future feature needs to address one occurrence across
serialization boundaries.

Terminal context now follows the same send path as every other context record: the persisted
message keeps its canonical link and structured record, while the provider projection replaces
the link with a readable marker and includes the excerpt once in the context envelope. The legacy
trailing `<terminal_context>` form is parsed only when reading messages sent by older clients.

## Sending and reading messages

The composer sends `message.text` as canonical prose with reference links and
`message.context.records` built from the draft (`buildMessageContext` in
`apps/web/src/lib/composerContextRecords.ts`). Expired terminal excerpts are dropped from both.
The server projects provider text at turn start (`ProviderCommandReactor`), so the persisted
message stays readable and the provider receives markers plus one envelope.

Review comments and preview annotations enter the draft through store mutators. A mounted composer
registers a context insertion handler so panel-originated references land at its current or
last-known caret; when no composer is mounted, the store appends them. Terminal excerpts and
attachments use the same caret-first behavior. Removing a chip in the editor removes the record;
removing a preview screenshot thumbnail removes its annotation and chip.

The transcript resolves a message with `resolveUserMessageContext`: structured context is used as
is, older messages are upgraded in memory. `ChatMarkdown` renders `t3-context://` links through
`renderContextReference`, which the timeline maps to chips: terminal and element show a tooltip,
review comments and preview annotations open a popover with the card, unknown kinds render the
unresolved chip. Mobile renders context links as their labels.

## Attachments

Image and file records use the draft attachment's local id as `contextId` and carry an
`attachmentId` binding. The composer sends the upload's pending id (or the local id on the
data-URL path, via the optional `id` on `UploadChatImageAttachment`); the server's `Normalizer`
rewrites every image and file record to the persisted id it assigns, so the stored message binds
records to real resources. Optimistic rows bind to local ids and are replaced by the server copy.

In the composer, attaching a file or image inserts a chip at the caret (appended when the editor
cannot take input). Files exist only as chips: a file whose last chip is deleted is removed and
its upload released, and drafts that predate references get a chip appended on hydration. Images
keep the thumbnail shelf as their inventory; deleting a chip leaves the image, and removing a
thumbnail that is still referenced asks for confirmation before removing both. Old drafts do not
gain image chips.

In the transcript an image chip opens the gallery preview and a file chip opens or downloads the
file. The gallery still shows every image; file rows remain only for files no chip references.

## Clipboard

Every copy path writes the canonical Markdown as `text/plain` and, when the selection holds
chips, a structured fragment under `web application/x-t3-context-fragment+json`
(`ComposerContextClipboardFragment`: version, source environment/thread/message, records; no
bytes, no URLs). Composer copy and cut add it through a Lexical command listener; transcript
selection copy adds it from an `onCopyCapture` on the user message body while chips re-emit their
links through `data-markdown-copy`; the whole-message button writes both through `ClipboardItem`
and falls back to plain text.

On paste the composer decodes the fragment before the plain text. Records the draft does not
already hold are imported: terminal excerpts and review comments as they are, preview
annotations rebuilt from their record, and images or files re-fetched through the source
environment's asset URL and attached under a fresh local id, with the pasted link rewritten to
that id. A pasted binary reads as an unresolved chip until its bytes arrive; a fragment from
another environment leaves binaries unresolved. Rendered chips and sent messages are never
mutated by a paste.

Pasting across threads, projects, or environments uses the same path: the client mints an asset
URL from the source environment, downloads the bytes, and attaches them here. There is no
server-side clone; if the source is unreachable or the attachment is gone, a toast says so and
the chip stays unresolved.

## Ids, persistence, and the stash

Producers keep their own id grammars; `toComposerContextId` folds anything outside
`[a-z0-9_-]` into a slug plus a hash, deterministically, at the reference and record boundary.
A preview annotation's context id is derived from `annotation-<id>` so it stays distinct from its
screenshot image, whose attachment id is the annotation id; the record links the two through
`screenshotContextId`.

`projection_thread_messages.context_json` persists records, so a restart or projection reload
keeps chips resolvable. Prompt stash entries carry `records` for terminal excerpts, review
comments, and preview annotations; stashing moves them out of the draft and restoring imports
them back through the same importer the paste path uses.

Context produced by other panels reaches the caret through `setContextInsertionHandler`: a
mounted composer registers an inserter for its draft and the store falls back to appending.
