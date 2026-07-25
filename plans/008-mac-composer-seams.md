# 008 — Composer seams: segmented control, hover intent, popover crossfades (mac)

- **Status**: DONE (context-meter hover intent shipped separately in #229 as `scheduleDetails`; our duplicate was dropped in the rebase onto `c0e157d37`)
- **Commit**: c9013c976
- **Severity**: MEDIUM
- **Category**: Easing & duration / accessibility / missed opportunities
- **Estimated scope**: 5 files, ~40 lines

## Problem

1. **Segmented-control Reduce-Motion crossfade never plays.** `AlpineSegmentedControl.swift:55` declares `.animation(Motion.reduceMotion ? nil : Motion.reveal, value: selection)` — a nil animation in the transaction means the `.transition(.opacity)` + `.id(selection)` thumb swap (`:69-73`) pops instantly, contradicting the file's own header comment and the app policy "state changes still ease — no jarring pops" (`Motion.swift:28-30`). The same line also uses the entering/leaving ease-out (`Motion.reveal`) for on-screen thumb _movement_, the curve role `Motion.ambient` (`timingCurve(0.77, 0, 0.175, 1)`, ease-in-out) exists for.
2. **Context meter popover fires on bare hover.** `ComposerControls.swift:520` — `.onHover { showDetails = $0 }` opens an `NSPopover` with zero intent delay; the meter sits on the pointer path to the send button, so it flashes open/closed on grazes many times a day.
3. **Dictation overlay phase swaps teleport.** `DictationLiveOverlay.swift:31-58` switches `dictation.state` between "Listening…", transcript, "Finishing…", "Polishing…" with no animation — hard re-labels at exactly the moments the user watches the overlay.
4. **Model-picker provider filter hard-cuts the list.** `ModelPickerPopover.swift:231,241` write `providerFilter` with no animation; the 400pt content region instantly rebuilds. (Per-keystroke search filtering correctly stays unanimated.)
5. **Run-profile segment pops in/out of the controls capsule.** `ComposerControls.swift:47-50` inserts/removes a divider + `RunProfileMenu` on model change with no animation.
6. **Search-field focus ring snaps.** `ModelPickerPopover.swift:207-214` strokes the field `searchFocused ? accent.opacity(0.75) : primary.opacity(0.12)` unanimated; focus is set programmatically on every popover open (`:177`).
7. **Dead transition declarations.** `ComposerBar.swift:176` — `SuggestionList` carries `.transition(Motion.pop(from: .bottomLeading))` with no keyed animation anywhere (typing is deliberately unanimated, `ComposerBar.swift:386-388` — settled decision); the declaration is misleading dead code.

## Target

```swift
// target — AlpineSegmentedControl.swift:55 (one line fixes both the RM pop and the curve role)
.animation(Motion.ambient, value: selection)
// Motion.ambient is 0.22s ease-in-out normally (thumb slide = on-screen movement)
// and collapses to 0.12s under Reduce Motion — a real animation, so the
// opacity thumb swap at :69-73 finally crossfades instead of popping.
```

```swift
// target — ComposerControls.swift ContextMeterView: hover-intent delay
@UIState private var showDetails = false
@UIState private var hoverIntentTask: Task<Void, Never>?

// The meter sits on the pointer path to Send; require a brief rest before
// the popover opens so grazes don't flash it.
.onHover { hovering in
    hoverIntentTask?.cancel()
    if hovering {
        hoverIntentTask = Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(300))
            guard !Task.isCancelled else { return }
            showDetails = true
        }
    } else {
        showDetails = false
    }
}
.onDisappear { hoverIntentTask?.cancel() }
```

```swift
// target — DictationLiveOverlay.swift body (~:17-21): crossfade phase content
HStack(alignment: .center, spacing: 10) {
    meter
    content
        .animation(Motion.reveal, value: dictation.state)
    Spacer(minLength: 0)
}
// DictationState is Equatable (DictationController.swift:6). Keyed on state,
// not the transcript, so streaming words don't retrigger it.
```

```swift
// target — ModelPickerPopover.swift:231 and :241
withAnimation(Motion.reveal) { providerFilter = .all }                 // :231
withAnimation(Motion.reveal) { providerFilter = .provider(provider) }  // :241
// plus, on `modelBrowser`:
.animation(Motion.reveal, value: providerFilter)
```

```swift
// target — ComposerControls.swift ComposerControlsRow body (~:44-56)
HStack(spacing: 0) {
    ModelPickerMenu(thread: thread, model: model)
    if showsRunProfile {
        segmentDivider
        RunProfileMenu(thread: thread, model: model)
    }
}
// …existing frame/background…
.animation(Motion.reveal, value: showsRunProfile)
```

```swift
// target — ModelPickerPopover.swift searchField (~:200-214): after the .overlay
.animation(Motion.feedback, value: searchFocused)
```

```swift
// target — ComposerBar.swift:173-177: delete the dead `.transition(...)` and
// extend the :386-388 comment to note suggestion menus intentionally carry no
// transition declaration (keyboard-frequency UI stays instant, per the
// settled typing decision).
```

## Repo conventions to follow

- All curves from `Theme/Motion.swift`: `Motion.ambient` (movement/status), `Motion.reveal` (content arrival), `Motion.feedback` (hover/focus). No inline curves.
- Keyboard-initiated and per-keystroke changes stay unanimated — this plan animates only pointer-driven, occasional changes.
- `DictationState` (`DictationController.swift:6-12`) and `ModelPickerProviderFilter` are `Equatable`; `showsRunProfile`, `searchFocused`, `showDetails` are `Bool`.

## Steps

1. `apps/mac/Sources/SergeCodeMac/UI/AlpineSegmentedControl.swift:55` — replace the selection animation line with `.animation(Motion.ambient, value: selection)`; touch the header comment (`:9-10`) so it names `Motion.ambient` driving both the slide and the Reduce-Motion crossfade.
2. `apps/mac/Sources/SergeCodeMac/UI/Composer/ComposerControls.swift` — apply the hover-intent Target to `ContextMeterView` (~:503, :520-523), and add `.animation(Motion.reveal, value: showsRunProfile)` after the capsule background in `ComposerControlsRow` (~:55).
3. `apps/mac/Sources/SergeCodeMac/UI/Composer/DictationLiveOverlay.swift` — apply the `content` animation Target.
4. `apps/mac/Sources/SergeCodeMac/UI/Composer/ModelPickerPopover.swift` — wrap both `providerFilter` writes in `withAnimation(Motion.reveal)`, add `.animation(Motion.reveal, value: providerFilter)` to `modelBrowser`, and `.animation(Motion.feedback, value: searchFocused)` at the end of `searchField`.
5. `apps/mac/Sources/SergeCodeMac/UI/Composer/ComposerBar.swift:176` — remove the dead `.transition(Motion.pop(from: .bottomLeading))` and extend the `:386-388` comment. While there, verify the editor placeholder near `:277`: if its `.transition(.opacity)` also has no keyed animation, remove it too; if something keys it, leave it.

## Boundaries

- Do NOT animate anything keyed to `draft`, `searchText`, suggestion results, or keystroke-adjacent state.
- Do NOT change `Motion.pop` itself — only the dead declaration is removed.
- Do NOT change popover content, layout, or the send button; `showsStop`/`canSend` behavior is settled.
- If a step doesn't match the code you find (drift since commit c9013c976), STOP and report instead of improvising.

## Verification

- **Mechanical**: `swift build --package-path apps/mac` succeeds, then `vp check` and `vp run typecheck` pass.
- **Feel check**:
  - Click through a segmented control (e.g. Changes view Files|Activity): the thumb glides with an ease-in-out; arrow-key moves also glide (feedback, not delay).
  - Reduce Motion on: the thumb crossfades (no slide, no pop).
  - Sweep the pointer across the context meter on the way to Send: no popover; rest on it ~0.3s: popover opens. Leave: closes immediately.
  - Dictate and stop: Listening… → Finishing… → (Polishing…) crossfade between phases.
  - Open the model picker: focus ring eases in; click provider filters: the list crossfades instead of hard-cutting; typing in search still filters instantly.
  - Switch between models with/without effort choices: the run-profile segment fades in/out of the capsule instead of popping.
- **Done when**: the seven seams animate (or, for dead code, are removed) as targeted and the build passes.
