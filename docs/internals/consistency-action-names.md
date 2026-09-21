# Action names agree across presentations

Proposed invariant: a command's visible label, tooltip, menu wording and accessible
name describe the same action on the same object. An icon-only presentation must
retain that meaning. This applies to shared web/Electron controls and corresponding
React Native iOS/Android actions, wherever those actions are available.

Separate strings can drift while each presentation still looks plausible. A message
copy action called “Copy link” promises a different clipboard payload to someone
using a screen reader. Use wording that identifies the actual target, including
when a message contains links or structured context. Additional clipboard formats
do not turn copying a message into copying a link.

This proposal draws on Apple's [Writing](https://developer.apple.com/design/human-interface-guidelines/writing)
and [Accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility)
guidance. It is a product constraint, not a claim of Apple certification or complete
application compliance.

## Boundaries

Native menus and assistive technologies may use different wording or omit a tooltip.
Labels need semantic agreement, not identical strings across platforms. A contextual
“Copy” is sufficient when its target is unambiguous; do not globally expand it.
Temporary “Copied” feedback may replace an action label without implying a different
target. Clipboard transport, success timing and error reporting are separate concerns.

## Observable cases

- User and assistant message copy controls identify the message, in both tooltip
  and accessible name. Collapsing a long message does not change the action's meaning.
- Copying a message with structured context still identifies the message; it does
  not promise to copy only a context link.
- Code and plan copy actions retain their own targets. A contextual plan menu can
  say “Copy to clipboard”; a code control must not be announced as copying a message.
- An icon, labeled button or native menu for an equivalent command conveys the same
  operation. Completed feedback never names a different object.

Verify visible wording alongside the runtime accessible name and resulting action.
Source inspection and screenshots alone do not establish accessibility-tree behavior.
