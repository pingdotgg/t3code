# 006 — Let user-initiated timeline disclosures animate mid-run (mac)

- **Status**: DONE
- **Commit**: c9013c976
- **Severity**: HIGH
- **Category**: Interruptibility / purpose (user clicks lose their animation)
- **Estimated scope**: 5 files, ~40 lines

## Problem

Clicking a tool call, tool group, plan card, delegated-task card, reasoning "Show More", or process-output disclosure **opens instantly while the agent is running** — the exact moment users click most. Root cause: `ChatTimelineScrollView` clears `transaction.animation` on the whole timeline `LazyVStack` whenever `suppressLayoutAnimation` is true (thread running, user scrolling, or initial anchor pending). That suppression is a deliberate, correct anti-judder measure for _streaming_ churn — but it is indiscriminate: it also flattens the `withDeferredAnimation(Motion.structure)` behind every _user-initiated_ disclosure click.

```swift
// apps/mac/Sources/SergeCodeMac/UI/Chat/ChatTimelineScrollView.swift:189-193 — current
.transaction { transaction in
    if suppressLayoutAnimation {
        transaction.animation = nil
    }
}
```

```swift
// apps/mac/Sources/SergeCodeMac/UI/Chat/ChatTimelineRow.swift:773 — current (ToolEventRow; the pattern the suppressor flattens)
withDeferredAnimation(Motion.structure) { isExpanded.toggle() }
```

Two adjacent defects fixed in the same plan:

1. `PlanCard.swift:34` and `DelegatedTaskCard.swift:64` use raw `withAnimation(Motion.structure)` instead of `withDeferredAnimation` — the same AppKit layout-feedback-loop hazard `DeferredAnimation.swift:3-6` documents for every sibling toggle.
2. `ThinkingIndicator` (`ChatTimelineScrollView.swift:164-169`) only ever appears/disappears mid-run, when the suppressor has cleared the ambient animation and `revealAnimation` returns nil — so its declared `.transition(Motion.rise)` never fires and it pops in/out at the timeline tail. Nothing else keys an animation to `showThinking`.

## Target

A custom `TransactionKey` marks disclosure transactions as user-initiated; the suppressor lets those through while continuing to nil everything else. All seven timeline disclosure toggles route through one marked, deferred helper. The thinking indicator gets a narrow `.animation(value:)` placed _downstream_ of the suppressor (downstream transaction modifiers win), so it rises/fades mid-run at both ends.

```swift
// target — apps/mac/Sources/SergeCodeMac/UI/Chat/DeferredAnimation.swift (append)
/// Marks a state change as a user-initiated disclosure toggle (a click on a
/// tool row, plan card, or Show More button). `ChatTimelineScrollView` clears
/// `transaction.animation` on the streaming timeline to stop layout churn —
/// a deliberate click deserves its animation even mid-run, so the suppressor
/// lets marked transactions through.
private enum IntentionalDisclosureKey: TransactionKey {
    static let defaultValue = false
}

extension Transaction {
    var isIntentionalDisclosure: Bool {
        get { self[IntentionalDisclosureKey.self] }
        set { self[IntentionalDisclosureKey.self] = newValue }
    }
}

/// `withDeferredAnimation` for disclosure toggles: defers one runloop turn
/// (the AppKit layout-feedback-loop guard above), then applies the animation
/// via a transaction marked as user-initiated so timeline-level animation
/// suppression does not flatten the expand/collapse the user just asked for.
@MainActor
func withDeferredDisclosureAnimation(
    _ animation: Animation = Motion.structure,
    action: @escaping @MainActor @Sendable () -> Void
) {
    DispatchQueue.main.async {
        var transaction = Transaction(animation: animation)
        transaction.isIntentionalDisclosure = true
        withTransaction(transaction, action)
    }
}
```

```swift
// target — ChatTimelineScrollView.swift suppressor
.transaction { transaction in
    // User-initiated disclosure toggles keep their animation even mid-run;
    // everything else (streaming churn, regroups) stays unanimated.
    if suppressLayoutAnimation && !transaction.isIntentionalDisclosure {
        transaction.animation = nil
    }
}
// The thinking indicator only ever appears/disappears mid-run, when the
// suppressor above has cleared the ambient animation. Re-arm a narrow
// reveal keyed to its flip so it rises/fades instead of popping. Placed
// after `.transaction` — downstream transaction modifiers win.
.animation(Motion.reveal, value: showThinking)
```

## Repo conventions to follow

- All curves come from `apps/mac/Sources/SergeCodeMac/Theme/Motion.swift`; `Motion.structure` is the documented curve for "occasional panels, disclosures, and intentional layout changes". No inline curves.
- Keep the `withDeferredAnimation` deferral pattern — `apps/mac/Sources/SergeCodeMac/UI/Chat/DeferredAnimation.swift:3-6` documents why (AppKit `_postWindowNeedsUpdateConstraints` guard). The new helper lives in the same file and preserves the deferral.
- Do not touch `suppressLayoutAnimation`, `revealAnimation`, `rowTransition`, or the `.animation(revealAnimation, value: displayItems.count)` line — the streaming carve-outs stay exactly as they are.

## Steps

1. `apps/mac/Sources/SergeCodeMac/UI/Chat/DeferredAnimation.swift` — append the `IntentionalDisclosureKey`, `Transaction.isIntentionalDisclosure`, and `withDeferredDisclosureAnimation` exactly as in Target. Leave the existing `withDeferredAnimation` untouched (it remains for non-disclosure callers, e.g. `MarkdownContent.swift:1698`).
2. `apps/mac/Sources/SergeCodeMac/UI/Chat/ChatTimelineScrollView.swift` (~line 189) — apply the Target suppressor change, then add `.animation(Motion.reveal, value: showThinking)` immediately **after** the `.transaction { ... }` block (before `.entranceSuppressed(isUserScrolling)`), with the Target comment.
3. `apps/mac/Sources/SergeCodeMac/UI/Chat/ChatTimelineRow.swift` — replace `withDeferredAnimation(Motion.structure) {` with `withDeferredDisclosureAnimation {` at exactly five call sites: line ~299 (UserMessageBubble Show More), ~609 (ToolGroupRow), ~773 (ToolEventRow), ~1208 (ReasoningRow Show More), ~1247 (SessionExitRow). Keep each adjacent comment; adjust wording only where it names `withDeferredAnimation`.
4. `apps/mac/Sources/SergeCodeMac/UI/Chat/PlanCard.swift:34` — replace `withAnimation(Motion.structure) { isExpanded.toggle() }` with `withDeferredDisclosureAnimation { isExpanded.toggle() }`.
5. `apps/mac/Sources/SergeCodeMac/UI/Chat/DelegatedTaskCard.swift:64` — replace `withAnimation(Motion.structure) { isExpanded.toggle() }` with `withDeferredDisclosureAnimation { isExpanded.toggle() }`.

## Boundaries

- Do NOT alter `suppressLayoutAnimation`'s conditions, `rowTransition`, `revealAnimation`, or any scroll re-anchor logic in `ChatTimelineScrollView.swift`.
- Do NOT add `.transition` modifiers anywhere in this plan — the rows already declare `Motion.unfold`; this plan only re-arms the animation behind them.
- Do NOT change `withDeferredAnimation`'s existing implementation or its other callers.
- Do NOT add new types outside `DeferredAnimation.swift`; the key and helper live there.
- If a step doesn't match the code you find (drift since commit c9013c976), STOP and report instead of improvising.

## Verification

- **Mechanical**: `swift build --package-path apps/mac` succeeds, then `vp check` and `vp run typecheck` pass (repository requirement).
- **Feel check** (use the `apps/mac/.claude/skills/verify` flow — mock backend + UIProbe — or run the app against a live thread):
  - While an agent turn is **running**, click a tool call row: the body unfolds on the smooth 0.24s structure curve and the chevron rotates — no instant pop. Click again: it collapses just as smoothly.
  - Same for a finished tool group ("Ran N tools"), a reasoning Show More, a plan card, and a delegated task card — all mid-run.
  - While running, watch streaming deltas arrive: rows still snap in unanimated (the suppression still works) and the transcript does not judder or blank.
  - The thinking indicator fades/rises in and out at the tail instead of popping.
  - Enable Reduce Motion: disclosures ease as quick fades (Motion.structure collapses to `reducedChange`), no movement.
- **Done when**: mid-run disclosure clicks visibly animate, streaming stays unanimated, and the build passes.
