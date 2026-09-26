# Preview presentation preserves write authority

Status: proposed cross-surface contract.

Changing a file's presentation must not grant permission to overwrite it.
A read-only file stays non-mutating in source, rendered Markdown, table,
HTML, and any other preview. An incomplete or truncated read cannot supply
bytes for a whole-file replacement, even when its visible prefix contains
an otherwise editable control such as a Markdown task checkbox.

## Rationale

Apple's [File management](https://developer.apple.com/design/human-interface-guidelines/file-management)
and [Undo and redo](https://developer.apple.com/design/human-interface-guidelines/undo-and-redo)
guidance informs this proposal: file actions should preserve people's work
and provide understandable recovery. These references do not establish that
T3 currently satisfies this contract. Replacing unseen bytes with a preview
prefix is data loss, not a change in presentation, and undo is not a substitute
for preserving the authority of the original read.

## Scope and boundary

The rule applies to previews reached from workspace browsing, chat file links,
and attachments in web, desktop, and React Native clients. It constrains any
inline edit that writes back to the original file; it does not require every
client or representation to offer editing.

The rendered control and the mutation boundary must both respect read authority.
Cached file state must retain whether its read is complete and writable, together
with an ordering token identifying that read. Edits and optimistic drafts retain
their originating token; optimistic contents cannot upgrade authority or hide a
newer read. Before queuing or flushing a replacement, including on disposal,
recheck that authority and reject edits whose token no longer matches the current
read. Missing authority or a read that is incomplete or read-only cannot authorize
replacement.

Whole-file replacement also requires a lossless byte round trip. Preserve the
original bytes or retain enough representation metadata to reproduce them,
including any UTF-8 byte-order mark and original line endings. If decoding loses
information or an encoding cannot round-trip unchanged bytes, inline replacement
must remain unavailable; displaying decoded text alone is not sufficient.

Viewing, copying, sharing, and downloading a separate copy remain available
where supported. A complete writable file may retain its supported inline edits.
External editors have their own file access and are outside this preview contract.

## Acceptance

- A Markdown file above the read limit, with a task at its start, cannot lose
  its unseen tail through a rendered task toggle or a source/rendered switch.
- A complete writable file can toggle its intended task marker while preserving
  every other byte, including a UTF-8 byte-order mark, line endings and non-ASCII
  text. A file that cannot round-trip its original bytes stays non-mutating.
- A complete read-only host file remains non-mutating in every representation.
- A newer truncated cached read prevents a previously available inline edit
  from queuing or flushing a whole-file replacement, including with an older
  optimistic draft or a save flushed during disposal.

These are acceptance requirements, not a claim of verified compliance across
all clients or protection against concurrent external file changes after a read.
