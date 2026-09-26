# Proposed: dismissing an editor preserves invested input

Status: proposed cross-surface decision, not ratified policy.

Leaving an unsent composition through Cancel, close, back, swipe, Escape or a
change of target should preserve the draft with its destination, or ask for an
explicit discard decision. Empty editors can close directly. Explicit Discard
is itself a decision; it does not need a second confirmation.

This applies to web and Electron review editors and React Native review sheets
and task composers. Controls can differ by platform. A draft belongs to its
environment and thread or pull request, plus its file, revision and selected
lines where applicable. Retaining words without that context risks sending them
to the wrong place.

Submission failure must retain the input. Success may clear only the submitted
snapshot, including attachments; new input entered during submission is still a
draft. Moving a review comment into the task composer is a submission boundary
for its editor, even though the agent has not received it yet.

Use existing draft stores when they already own the composition. Otherwise,
protect removal at the navigation boundary so native back and swipe cannot
bypass an on-screen button. Do not add confirmations to ordinary navigation
that already preserves drafts. This decision does not promise recovery after
process termination for editors whose existing lifetime is the current session.

The rationale is recoverability with minimal interruption, informed by Apple's
[Undo and redo](https://developer.apple.com/design/human-interface-guidelines/undo-and-redo)
and [Modality](https://developer.apple.com/design/human-interface-guidelines/modality)
guidance. These references do not prescribe identical controls across platforms.

Acceptance cases:

- An empty editor closes without a prompt; text alone or attachments alone
  cannot disappear through an ambiguous dismissal.
- Keeping a draft after a discard prompt preserves its text, files and target;
  confirming Discard closes it. Repeated dismissal attempts do not stack prompts.
- Close, back, swipe, Escape and parent navigation obey the same data-loss rule.
- Reopening preserved input restores its original destination. A new selection
  cannot silently retarget an editor that is already open.
- Adding to a full destination draft fails without partial transfer or loss;
  correcting the capacity problem permits a retry.
- Successful transfer closes without a discard prompt and preserves destination
  content. Any later edits remain available for the next submission.
