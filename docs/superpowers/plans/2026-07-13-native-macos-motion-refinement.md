# Native macOS Motion Refinement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make SurgeCode's routine native macOS interactions crisp and immediate while reserving restrained one-shot personality for rare successful state changes.

**Architecture:** Keep `Motion.swift` as the semantic motion boundary, add a small pure `MotionProfile` for testable timing and accessibility policy, and scope animation to the smallest changing view. Remove animation from keyboard/typing/hydration paths, quiet persistent status indicators, and trigger rare delight only from live state transitions.

**Tech Stack:** Swift 6.1, SwiftUI for macOS 26+, Swift Testing, existing `@UIState` compatibility shim, `vp` repository tooling.

---

### Task 1: Define and test the semantic motion profile

**Files:**

- Modify: `apps/mac/Sources/SergeCodeMac/Theme/Motion.swift`
- Create: `apps/mac/Tests/SergeCodeMacTests/MotionTests.swift`

- [ ] **Step 1: Write failing motion-policy tests**

```swift
import Testing

@testable import SergeCodeMac

@Suite("Motion policy")
struct MotionTests {
    @Test("routine motion stays within the responsiveness budget")
    func routineDurations() {
        let profile = MotionProfile(reduceMotion: false)
        #expect(profile.feedbackDuration == 0.14)
        #expect(profile.revealDuration == 0.19)
        #expect(profile.structureDuration == 0.24)
        #expect(profile.structureDuration <= 0.26)
        #expect(profile.delightDuration <= 0.42)
    }

    @Test("reduced motion removes movement and decorative effects")
    func reducedMotion() {
        let profile = MotionProfile(reduceMotion: true)
        #expect(profile.changeDuration == 0.12)
        #expect(!profile.usesMovement)
        #expect(!profile.allowsDecorativeEffects)
    }

    @Test("ordinary motion permits movement and rare effects")
    func ordinaryMotion() {
        let profile = MotionProfile(reduceMotion: false)
        #expect(profile.usesMovement)
        #expect(profile.allowsDecorativeEffects)
    }
}
```

- [ ] **Step 2: Run the focused test and confirm it fails**

Run the native test command from `apps/mac/CLAUDE.md` filtered to `MotionTests`.

Expected: compilation fails because `MotionProfile` does not exist.

- [ ] **Step 3: Add the pure policy and semantic SwiftUI tokens**

```swift
struct MotionProfile: Equatable, Sendable {
    let reduceMotion: Bool
    let feedbackDuration = 0.14
    let revealDuration = 0.19
    let structureDuration = 0.24
    let delightDuration = 0.40
    var changeDuration: Double { reduceMotion ? 0.12 : revealDuration }
    var usesMovement: Bool { !reduceMotion }
    var allowsDecorativeEffects: Bool { !reduceMotion }
}
```

Use that profile to expose `feedback`, `reveal`, `structure`, `delight`, and
`ambient` animations plus asymmetric `rise`, `materialize`, `pop`, `banner`,
`unfold`, and `paneChange` transitions. Routine tokens must be 260 ms or less;
`delight` must be 420 ms or less. Movement-bearing transitions degrade to
opacity under Reduce Motion.

- [ ] **Step 4: Run `MotionTests` and confirm it passes**

Expected: all three tests pass.

- [ ] **Step 5: Commit the policy boundary**

```bash
git add apps/mac/Sources/SergeCodeMac/Theme/Motion.swift \
  apps/mac/Tests/SergeCodeMacTests/MotionTests.swift
git commit -m "refactor(mac): define semantic motion profile"
```

### Task 2: Remove animation from typing and frequent navigation

**Files:**

- Modify: `apps/mac/Sources/SergeCodeMac/UI/Composer/ComposerBar.swift`
- Modify: `apps/mac/Sources/SergeCodeMac/UI/Chat/ChatScreen.swift`
- Modify: `apps/mac/Sources/SergeCodeMac/ContentView.swift`
- Modify: `apps/mac/Sources/SergeCodeMac/UI/Shell/SidebarView.swift`

- [ ] **Step 1: Remove the whole-composer draft animation**

Delete `.animation(..., value: draft)`. Keep explicit short reveals for
suggestions, attachments, queued messages, and errors, each keyed only to the
smallest relevant identity collection. Replace old token names with the Task 1
semantic equivalents.

- [ ] **Step 2: Make thread selection immediate**

Remove animation keyed to `selectedThreadID` from `ChatScreen`. Retain a scoped
structural transition only for chat versus review mode. In `ContentView`, keep
the occasional empty-state versus selected-session transition but do not add a
per-thread transition.

- [ ] **Step 3: Stop animating complete sidebar collections**

Remove whole-list animations keyed to thread IDs, pinned IDs, projects, and
remote sessions. Add or retain row-local insertion/removal transitions only
where row identity changes.

- [ ] **Step 4: Build the macOS package**

Run: `swift build --package-path apps/mac`

Expected: build succeeds with no references to removed motion tokens.

- [ ] **Step 5: Commit frequent-path cleanup**

```bash
git add apps/mac/Sources/SergeCodeMac/ContentView.swift \
  apps/mac/Sources/SergeCodeMac/UI/Composer/ComposerBar.swift \
  apps/mac/Sources/SergeCodeMac/UI/Chat/ChatScreen.swift \
  apps/mac/Sources/SergeCodeMac/UI/Shell/SidebarView.swift
git commit -m "perf(mac): remove motion from frequent input paths"
```

### Task 3: Refine timeline, scroll, and structural transitions

**Files:**

- Modify: `apps/mac/Sources/SergeCodeMac/UI/Chat/ChatTimelineScrollView.swift`
- Modify: `apps/mac/Sources/SergeCodeMac/UI/Chat/ChatTimelineRow.swift`
- Modify: `apps/mac/Sources/SergeCodeMac/UI/Chat/PlanCard.swift`
- Modify: `apps/mac/Sources/SergeCodeMac/UI/Chat/PlanProgressStrip.swift`
- Modify: `apps/mac/Sources/SergeCodeMac/UI/Diff/DiffReviewView.swift`
- Modify: `apps/mac/Sources/SergeCodeMac/UI/Diff/ChangesTimelineView.swift`

- [ ] **Step 1: Keep initial and hydrated history still**

Preserve the existing `pendingInitialScrollThreadID` guard and use `Motion.reveal`
only when `items.count` increases after initial positioning. Streaming content
changes remain unanimated because the key is structural count, not content.

- [ ] **Step 2: Shorten appended-row and pinned-scroll motion**

Use a 4-6 point asymmetric rise for genuinely appended rows and `Motion.structure`
for the one programmatic bottom scroll after a new row. Thread switching and
initial scroll positioning stay unanimated.

- [ ] **Step 3: Retune disclosures and pane changes**

Use `Motion.feedback` for chevrons and explicit user toggles, `Motion.structure`
for content expansion, and faster opacity-only removal. Replace broad animation
on streamed plan-step arrays with row-local symbol/content transitions.

- [ ] **Step 4: Build and run timeline-focused tests**

Run the native test command filtered to `StreamingMarkdownTests`,
`TimelineGroupingCacheTests`, and `MotionTests`.

Expected: tests pass and the package builds.

- [ ] **Step 5: Commit timeline refinements**

```bash
git add apps/mac/Sources/SergeCodeMac/UI/Chat \
  apps/mac/Sources/SergeCodeMac/UI/Diff
git commit -m "refactor(mac): tighten timeline and disclosure motion"
```

### Task 4: Quiet ongoing status motion and add rare success accents

**Files:**

- Modify: `apps/mac/Sources/SergeCodeMac/UI/Shell/ConnectionStatusPill.swift`
- Modify: `apps/mac/Sources/SergeCodeMac/UI/Shell/AgentsPanel.swift`
- Modify: `apps/mac/Sources/SergeCodeMac/UI/Shell/SidebarView.swift`
- Modify: `apps/mac/Sources/SergeCodeMac/UI/Chat/SubagentTaskComponents.swift`
- Modify: `apps/mac/Sources/SergeCodeMac/UI/Chat/ChatTimelineRow.swift`
- Modify: `apps/mac/Sources/SergeCodeMac/UI/Chat/PlanProgressStrip.swift`
- Modify: `apps/mac/Sources/SergeCodeMac/UI/Chat/ChatHeaderView.swift`

- [ ] **Step 1: Replace perpetual scale pulses**

Connection and agent pills use a quiet opacity treatment while work is active.
Sidebar foreground/background work indicators become static active markers or a
single restrained acknowledgement instead of a repeating scale animation.

- [ ] **Step 2: Add first live connection acknowledgement**

Track a local integer value in `ConnectionStatusPill`. Increment only when an
existing view observes a transition from a non-ready phase to `.ready`, and only
when `Motion.profile.allowsDecorativeEffects`. Apply a non-repeating SF Symbol
bounce to the status glyph keyed to that value. An already-ready initial render
must not animate.

- [ ] **Step 3: Restrict task delight to successful completion**

Change task status icon bounce values from the complete state enum to a success
boolean:

```swift
icon.symbolEffect(
    .bounce,
    value: Motion.reduceMotion ? false : task.state == .completed)
```

Use the equivalent `displayState == .succeeded` expression for tool activity.
Failures, pauses, and routine running updates use only symbol replacement. Gate
the plan-progress pulse behind Reduce Motion.

- [ ] **Step 4: Build the macOS package**

Run: `swift build --package-path apps/mac`

Expected: build succeeds and no repeating scale animation remains in native
status components.

- [ ] **Step 5: Commit status and delight changes**

```bash
git add apps/mac/Sources/SergeCodeMac/UI/Shell \
  apps/mac/Sources/SergeCodeMac/UI/Chat
git commit -m "feat(mac): add restrained success motion"
```

### Task 5: Retune remaining native animation call sites

**Files:**

- Modify: animation call sites under `apps/mac/Sources/SergeCodeMac/UI/`
- Modify: `apps/mac/Sources/SergeCodeMac/Theme/SceneryViews.swift`
- Modify: `apps/mac/Sources/SergeCodeMac/UI/Shell/EmptyStateView.swift`

- [ ] **Step 1: Replace every legacy token reference**

Use `rg` to find `Motion.snap`, `Motion.settle`, `Motion.enter`, old transition
names, raw `.easeInOut`, and ungated `.symbolEffect` calls. Map each call site by
purpose: feedback, reveal, structure, ambient, or rare delight.

- [ ] **Step 2: Preserve justified atmospheric motion**

Keep the scenery photo crossfade as an occasional atmospheric transition, but
route it through a named motion token and honor Reduce Motion. Keep empty-state
materialization as rare delight without replaying it during per-thread navigation.

- [ ] **Step 3: Remove or gate unjustified effects**

Delete routine bounce and repeated pulse effects. Ensure every decorative SF
Symbol effect and movement transition checks reduced-motion policy.

- [ ] **Step 4: Run static motion searches and build**

Run:

```bash
rg -n --glob '*.swift' 'Motion\.(snap|settle|enter)|easeInOut\(|repeatForever|symbolEffect' \
  apps/mac/Sources/SergeCodeMac
swift build --package-path apps/mac
```

Expected: remaining raw/repeating effects are individually justified and gated;
the build succeeds.

- [ ] **Step 5: Commit the complete call-site migration**

```bash
git add apps/mac/Sources/SergeCodeMac
git commit -m "refactor(mac): unify native animation call sites"
```

### Task 6: Full verification and motion review

**Files:**

- Modify only if verification exposes a defect.

- [ ] **Step 1: Run the complete native test suite**

Run the exact Swift test command from `apps/mac/CLAUDE.md`, including the testing
plugin and both runtime rpaths.

Expected: all native tests pass.

- [ ] **Step 2: Run required repository checks**

Run:

```bash
vp check
vp run typecheck
```

Expected: both commands exit successfully.

- [ ] **Step 3: Build and launch the app bundle**

Run `apps/mac/scripts/make-app.sh`, launch the resulting development app, and
inspect typing, suggestions, send/stop, thread navigation, new timeline rows,
streaming, disclosures, review mode, connection, background work, and task
completion.

Expected: frequent actions are immediate; occasional structural changes finish
within 260 ms; success accents fire once.

- [ ] **Step 4: Verify Reduce Motion**

Enable macOS Reduce Motion, repeat the interaction pass, and confirm movement,
bounce, rotation, and pulse are absent while opacity/color feedback remains.

- [ ] **Step 5: Run the animation review rubric again**

Confirm there are no high-frequency animations, routine durations above 300 ms,
unjustified perpetual effects, ungated movement, or broad typing/list animation
domains. Review uncertain motion in slow motion before accepting it.

- [ ] **Step 6: Commit any verification-only fixes**

```bash
git add apps/mac
git commit -m "fix(mac): polish verified motion behavior"
```
