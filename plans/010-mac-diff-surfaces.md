# 010 — Diff surfaces: pane swaps, file-switch crossfade, row hover (mac)

- **Status**: DONE (Files↔Activity mode swap and row extraction made obsolete by #221's unified-feed restructure of `ChangesTimelineView`; the All Changes hover residual landed after the rebase)
- **Commit**: c9013c976
- **Severity**: MEDIUM
- **Category**: Missed opportunities / cohesion
- **Estimated scope**: 2 files, ~45 lines

## Problem

1. **Files ↔ Activity mode swap hard-cuts.** `ChangesTimelineView.swift:51-59` switches the `LazyVStack` content on `mode` with no transition and no keyed animation; only the DEBUG UIProbe harness animates it (`:80-85`). `Motion.paneChange` is documented for exactly this ("inspector tabs", `Motion.swift:154-158`).
2. **Diff-review file switch never plays its declared crossfade.** `DiffReviewView.swift:392-393` and `:413-414` pair `.id(selectedFileKey)` with `.transition(Motion.paneChange)`, but nothing keys an animation to `selectedFileKey` — `model.selectReviewFile` is called bare from the file popover (`:245`) and `stepFile` (`:562`) — so the `.id` swap hard-cuts. The async spinner→content swap (`:347-349`) also pops.
3. **Inspector file rows have zero hover feedback.** `changedFileRow` (`ChangesTimelineView.swift:179-197`, used by the Button at `:169-172`) and `allChangesRow` (`:240-286`) are `.buttonStyle(.plain)` with no `.onHover`/wash; every comparable row surface animates a hover wash (`SidebarView.swift:750-760`, `ChangesQuietIconButton` at `:570-592`).
4. **Checkpoint file expansion uses the press curve.** `ChangesTimelineView.swift:447` and `:472` toggle `expandedFileCheckpoints` with `withAnimation(Motion.feedback)` — a structural reveal on the 0.14s pointer curve; `Motion.structure` owns disclosures.

## Target

```swift
// target — ChangesTimelineView.swift mode swap (~:49-63)
ScrollView {
    LazyVStack(alignment: .leading, spacing: 0) {
        Group {
            switch mode {
            case .files:
                filesList
            case .activity:
                allChangesRow
                if !checkpoints.isEmpty {
                    timelineSpine
                }
            }
        }
        .transition(Motion.paneChange)
        .id(mode)
    }
    .padding(.vertical, 8)
}
.frame(maxWidth: .infinity, maxHeight: .infinity)
.animation(Motion.reveal, value: mode)
```

```swift
// target — DiffReviewView.swift: after the Group at :346-368, before .onAppear
.animation(Motion.reveal, value: selectedFileKey)
.animation(Motion.reveal, value: isPreparing)
// DiffSelectionKey is Hashable (already used as .id); isPreparing is Bool.
// Keying the value covers both call sites (popover :245, stepFile :562) —
// no withAnimation wraps needed. The spinner↔content swap crossfades via the
// default opacity transition in the same animated transaction.
```

```swift
// target — ChangesTimelineView.swift changedFileRow: per-row hover wash.
// Extract a private button view so each row owns its hover state, mirroring
// ChangesQuietIconButton (:570-592):
private struct ChangedFileRowButton: View {
    let file: DiffFile
    let action: () -> Void

    @UIState private var isHovering = false

    var body: some View {
        Button(action: action) {
            // …the exact current changedFileRow(_:) HStack content…
        }
        .buttonStyle(.plain)
        .background {
            if isHovering {
                RoundedRectangle(
                    cornerRadius: AlpineTheme.Corners.compact, style: .continuous
                )
                .fill(Color.primary.opacity(0.07))
            }
        }
        .onHover { isHovering = $0 }
        .animation(Motion.feedback, value: isHovering)
    }
}
// call site :169-173 keeps its .entrance(.row, index: index) on the button.

// target — allChangesRow (:240-286): same wash, keyed on the view's own state
// (add @UIState private var isHoveringAllChanges = false to ChangesTimelineView):
.background(
    selected ? AlpineTheme.accent.opacity(0.12)
        : isHoveringAllChanges ? Color.primary.opacity(0.07) : Color.clear)
// …after .buttonStyle(.plain):
.onHover { isHoveringAllChanges = $0 }
.animation(Motion.feedback, value: isHoveringAllChanges)
.animation(Motion.feedback, value: selected)
```

```swift
// target — ChangesTimelineView.swift:447 and :472
withAnimation(Motion.structure) {
    _ = expandedFileCheckpoints.insert(checkpoint.id)   // :447
}
withAnimation(Motion.structure) {
    _ = expandedFileCheckpoints.remove(checkpoint.id)   // :472
}
```

## Repo conventions to follow

- Curves only from `Theme/Motion.swift`: `Motion.reveal` (pane/content swaps), `Motion.paneChange` (inspector tab swap), `Motion.feedback` (hover), `Motion.structure` (disclosures).
- Hover-wash idiom: `ChangesQuietIconButton` (`ChangesTimelineView.swift:570-592`) — `Color.primary.opacity(0.07)` in a compact-corner RoundedRectangle, `Motion.feedback`.
- Do NOT wrap `model.selectReviewFile` calls in `withAnimation` — the `.animation(value:)` keys cover both write sites.

## Steps

1. `apps/mac/Sources/SergeCodeMac/UI/Diff/ChangesTimelineView.swift` — apply the mode-swap Target (Group + `.transition(Motion.paneChange)` + `.id(mode)` inside the LazyVStack, `.animation(Motion.reveal, value: mode)` on the ScrollView); extract `ChangedFileRowButton` and use it at the `:169-173` call site (moving `changedFileRow(_:)`'s HStack into it — delete the now-dead function or keep it as the label builder, executor's choice, but no duplicated row markup); apply the `allChangesRow` Target; swap `Motion.feedback` → `Motion.structure` at `:447` and `:472`.
2. `apps/mac/Sources/SergeCodeMac/UI/Diff/DiffReviewView.swift` — add the two `.animation` lines after the `Group` at `:346-368` (before the `.onAppear` at `:369`).

## Boundaries

- Do NOT touch diff row preparation, zoom, or `prepareRows` logic.
- Do NOT animate `renderedMode` (unified ↔ side-by-side) — out of audited scope.
- Do NOT change the DEBUG UIProbe `withAnimation` blocks at `ChangesTimelineView.swift:80-85` (they become redundant but stay harmless).
- Leave the `.entrance(.row, index:)` on file-row buttons intact.
- If a step doesn't match the code you find (drift since commit c9013c976), STOP and report instead of improvising.

## Verification

- **Mechanical**: `swift build --package-path apps/mac` succeeds, then `vp check` and `vp run typecheck` pass.
- **Feel check** (UIProbe can drive `changes-timeline`, `checkpoints`, `activity` sections):
  - Toggle Files|Activity: the pane crossfades with the whisper-of-scale `paneChange` instead of hard-cutting; the segmented thumb glides (plan 008's curve fix).
  - In review, step files with the chevron buttons or pick from the file popover: the diff crossfades; the spinner fades into content.
  - Hover file rows in the inspector and the All Changes row: wash fades in/out on `Motion.feedback`.
  - Expand a >6-files checkpoint: rows settle on the structure curve.
  - Reduce Motion on: paneChange collapses to opacity, no scale; washes remain.
- **Done when**: all four seams animate as targeted and the build passes.
