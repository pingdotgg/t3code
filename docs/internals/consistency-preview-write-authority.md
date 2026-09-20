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
A callback created from a complete read must recheck current cached data before
queuing a replacement. Optimistic contents must not hide a newer truncated read.
If complete contents are unavailable, the preview cannot authorize replacement.

Viewing, copying, sharing, and downloading a separate copy remain available
where supported. A complete writable file may retain its supported inline edits.
External editors have their own file access and are outside this preview contract.

## Acceptance

- A Markdown file above the read limit, with a task at its start, cannot lose
  its unseen tail through a rendered task toggle or a source/rendered switch.
- A complete writable file can toggle its intended task marker while preserving
  every other byte, including line endings and non-ASCII text.
- A complete read-only host file remains non-mutating in every representation.
- A newer truncated cached read prevents a previously available inline edit
  from queuing a whole-file replacement, including with an older optimistic draft.

These are acceptance requirements, not a claim of verified compliance across
all clients or protection against concurrent external file changes after a read.
