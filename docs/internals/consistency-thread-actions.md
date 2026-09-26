# Proposed: thread actions remain available in the conversation

Opening a thread should retain an accessible route to its supported lifecycle
actions. The list and the conversation must use the same target, capability
checks, confirmation and inverse action. The user should not have to leave the
conversation just to rename, organize or remove it.

This is a proposed cross-surface constraint, informed by Apple's
[Context menus](https://developer.apple.com/design/human-interface-guidelines/context-menus)
and [Undo and redo](https://developer.apple.com/design/human-interface-guidelines/undo-and-redo)
guidance. It does not prescribe identical desktop and phone layouts or claim
prior maintainer approval.

Core coverage is rename, supported title regeneration, pin/unpin, settle/unsettle,
snooze/wake, archive/unarchive and delete. Each action belongs to the opened
thread's environment, including in split layouts and remote connections.
Unsupported server capabilities must not become commands. Preserve the distinct
action policies at both entry points:

- Manual Settle rejects starting or running sessions, queued turn starts, pending
  approvals and native input callbacks. It may dismiss an idle thread’s unanswered
  async questions without answering them or restarting the agent; automatic
  settlement must not dismiss those questions.
- Snooze permits a running session but rejects pending approvals, user-input
  requests and queued turn starts. It changes visibility without stopping work.
- Archive retains the existing guard against a running active turn; pending
  requests and queued input do not independently block it.
- Delete retains the shared destructive confirmation even with running or pending
  work; this proposal adds no pending-work eligibility guard. Confirmation is an
  explicit decision to delete the thread, not to answer its pending requests.

Web and Electron already share the thread action menu between list and header.
React Native conversation headers should reuse the mutations and confirmations from
[both list modes](../../apps/mobile/src/features/home/useThreadListActions.ts).
iOS uses a native header menu; Android uses the existing header menu primitive.
The conversation's Snooze action should open the existing date/duration sheet. A list
may offer quicker presets without changing the operation's meaning.

Pin, settle and snooze keep the conversation open, with the corresponding inverse
available. Archive and delete return to the thread list only after success and
only if the originating conversation is still focused. Failure retains the
conversation. Archived conversations offer Unarchive. Successful Unarchive keeps
the conversation open if it is still focused; if the user has navigated away, it
must not reopen or focus that conversation. Permanent deletion retains the shared
destructive confirmation and has no invented undo.

Arrangement is a list-specific operation. Git commands, terminal actions,
new-thread-on-branch, and copy-reference shortcuts are purpose-based subsets, not
requirements to repeat every lifecycle command in every toolbar or palette.

Acceptance includes capability skew, inverse states, pending requests, failed
mutations, environment-qualified identity, compact/split layouts, iOS/Android
menu access, and navigating away while a command is pending. Native touch and
screen-reader behavior need verification in a real client in addition to policy
tests.
