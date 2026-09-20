# Visible recovery from reversible organization

Status: proposed decision.

Archiving, settling, snoozing, and pinning reorganize a thread without deleting it.
The destination where the thread can be found should offer a visible control
that exposes its inverse action, with a meaningful accessible name. Recovery
must target the same thread in the same environment. A swipe or long press can provide an additional shortcut; discovering that
gesture must not be required to recover a thread. Desktop controls may appear
in context on hover when keyboard focus also reveals and operates them.

This rule applies to recovery destinations across web, desktop, and React Native
iOS and Android. Controls can use each platform's native menus and input model;
they need not look identical. Opening a live thread has separate action needs.
An unavailable server capability must remain unavailable through every route.
Irreversible deletion is an intentional exception: it stays separate from
recovery and retains its existing confirmation and consequence policy.

Apple's [Undo and redo](https://developer.apple.com/design/human-interface-guidelines/undo-and-redo),
[Gestures](https://developer.apple.com/design/human-interface-guidelines/gestures),
and [Accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility)
guidance informs this proposal. The cross-surface rule is a T3 design proposal,
not a claim of Apple certification or maintainer ratification.

Acceptance means someone can find a hidden thread, discover its recovery action
without a gesture demonstration, and activate it with touch, keyboard where
supported, or a screen reader. The visible route and shortcut must preserve the
same target, pending/error behavior, and deletion policy. Verify duplicate thread
identifiers in different environments, cancelled deletion, failed recovery, and
recovery followed by hiding the thread again. Source inspection establishes
available routes; native interaction and assistive-technology proof require a
real client.
