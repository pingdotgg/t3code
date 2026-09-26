# Copy feedback tells the truth

Proposed invariant: a copy control reports the clipboard's actual outcome. A
failed write reaches the client UI; a label, checkmark or toast meaning “Copied”
appears only after the write succeeds. This applies to corresponding copy actions
across web, Electron and React Native iOS/Android, including buttons, menus and
keyboard actions whose completion the app can observe.

A control can acknowledge accepted input before completion. Immediate light-impact
or selection haptics and pressed styling acknowledge a tap; they do not claim the
clipboard changed. Preserve this distinction when adapting feedback to a platform.

Clipboard writes can be delayed or refused independently of the gesture. Reporting
success at press time hides that boundary, while console-only failure leaves the
person without an explanation or a useful next step. Apple's
[Feedback](https://developer.apple.com/design/human-interface-guidelines/feedback)
and [Writing](https://developer.apple.com/design/human-interface-guidelines/writing)
guidance informs this proposal; the exact feedback channel is a product choice.

## Boundaries

- Show failure through an available client UI channel, such as an inline message,
  alert or toast. A control outside a toast host still needs visible feedback.
- Retrying uses the same intended content. Keep the source available after failure;
  do not clear the message, file text or diagnostic report being copied.
- Preserve plain text and supported rich/context payloads. Corresponding controls
  use the client's supported clipboard capabilities, including the existing plain
  HTTP fallback on web. Remote access must not silently reduce individual controls.
- Describe the failed action without displaying the copied content in diagnostics.
- OS/native terminal copy shortcuts may race several clipboard mechanisms without
  a reliable app-level completion receipt. Those native shortcuts are outside the
  outcome-reporting contract; terminal context-menu actions with observable write
  completion remain covered. Absence of a “Copied” label alone is not an exception.

## Observable cases

- A delayed write produces no completed-copy state until it succeeds.
- A rejected write produces visible failure and no success state.
- Retrying after failure copies the unchanged source content.
- Supported plain HTTP copying continues to work across equivalent web controls.
- Immediate acknowledgment haptics still occur on press, on success and failure.

This contract defines desired behavior, not a claim that every current copy path
already meets it. Native presentations can differ while preserving the same outcome.
