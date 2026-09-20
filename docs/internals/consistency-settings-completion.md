# Settings completion follows persistence

Proposed contract, not a ratified maintainer decision: a settings form that says
“Added” or “Saved”, or closes to signal a successful save, must first receive
confirmation from the store that owns the setting. Accepting input or scheduling
an update is not that confirmation.

[Apple's Feedback guidance](https://developer.apple.com/design/human-interface-guidelines/feedback)
and [Loading guidance](https://developer.apple.com/design/human-interface-guidelines/loading)
support keeping people informed while work proceeds. Here, that means a pending
save prevents duplicate submission; a failed or interrupted save keeps the draft
and provides a retry path. Only confirmed success may clear the form or announce
completion.

This boundary spans the form, client command, and authoritative persistence.
Awaiting a convenience updater that returns `void` does not cross it. Server-owned
settings require the command's successful receipt for the environment selected at
submission. Closing, reopening, or changing environments must detach the old
completion from the new form; it does not cancel or undo a server write.

The rule applies to explicit settings completion claims in web, Electron, and
React Native where those forms exist. The additional-provider form and custom-model editors are shared by
web and Electron. Custom-model add and edit retain their drafts until the
environment confirms persistence; removal cleans up local preferences only
after that confirmation. Quiet optimistic preference controls may remain optimistic
when failures are surfaced and effective state reconciles. This contract does
not require modal saves for toggles, change shared-setting synchronization, or
extend to clipboard acknowledgements.

Observable acceptance cases are delayed success with pending feedback and one
submission; rejection or interruption with retained input and an actionable
error; successful retry; and an old receipt arriving after a form or environment
change without dismissing the current form or announcing its success. A server
receipt confirms persistence, not provider authentication or readiness.
