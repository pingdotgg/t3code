# 001 — Animate press feedback in the two custom ButtonStyles (mac)

- **Status**: TODO
- **Commit**: 774d2f560
- **Severity**: MEDIUM
- **Category**: Physicality & origin (missing press feedback)
- **Estimated scope**: 2 files, ~6 lines

## Problem

The mac app has exactly two custom `ButtonStyle`s that read `configuration.isPressed`, and both jump their fill opacity instantly on press — no scale, no animation. Hover states elsewhere in the app animate through `Motion.feedback`, so the press-down path is the one un-animated interaction. These are the follow-up action buttons under every finished agent turn and the one-click merge pill — pressed many times a day.

```swift
// apps/mac/Sources/SergeCodeMac/UI/Chat/ChatFollowUpBar.swift:219 — current
private struct NatureActionButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.callout.weight(.medium))
            .padding(.horizontal, 12)
            .padding(.vertical, 5)
            .background {
                RoundedRectangle(cornerRadius: AlpineTheme.Corners.control, style: .continuous)
                    .fill(AlpineTheme.userBubbleTop.opacity(configuration.isPressed ? 0.78 : 0.94))
            }
            .foregroundStyle(AlpineTheme.forest)
            .shadow(color: .black.opacity(0.25), radius: 3, y: 1)
    }
}
```

```swift
// apps/mac/Sources/SergeCodeMac/UI/Shell/VcsToolbar.swift:345 — current
private struct VcsMergePillButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.caption.weight(.medium))
            .padding(.horizontal, 10)
            .padding(.vertical, 4)
            .background {
                Capsule()
                    .fill(.white.opacity(configuration.isPressed ? 0.75 : 0.92))
            }
            .foregroundStyle(.black)
            .shadow(color: .black.opacity(0.2), radius: 2, y: 1)
    }
}
```

## Target

Both styles gain a subtle press scale (0.97 — inside the sanctioned 0.95–0.98 band) and animate all pressed-state changes with the app's `Motion.feedback` curve (`timingCurve(0.23, 1, 0.32, 1)` @ 0.14s — inside the 100–160ms press-feedback budget). Under Reduce Motion the scale is skipped entirely (the fill-opacity change remains as the accessible feedback, matching the app's "movement collapses, fades stay" policy in `Theme/Motion.swift`).

```swift
// target shape (apply identically in both styles, after the existing modifiers)
configuration.label
    // ...existing font/padding/background/foregroundStyle/shadow unchanged...
    .scaleEffect(configuration.isPressed && !Motion.reduceMotion ? 0.97 : 1)
    .animation(Motion.feedback, value: configuration.isPressed)
```

## Repo conventions to follow

- All motion routes through `apps/mac/Sources/SergeCodeMac/Theme/Motion.swift`. Never write an inline `.spring(`/`.easeOut(`/`.timingCurve(` — use `Motion.feedback`.
- `Motion.feedback` already handles Reduce Motion internally (collapses to a 0.12s ease-out fade), so the `.animation(...)` call needs no gating; only the *scale movement* needs the `!Motion.reduceMotion` gate.
- Exemplar of the animation pattern — hover feedback in `apps/mac/Sources/SergeCodeMac/UI/Shell/SidebarView.swift:613-614`:
  ```swift
  .onHover { isHovering = $0 }
  .animation(Motion.feedback, value: isHovering)
  ```

## Steps

1. `apps/mac/Sources/SergeCodeMac/UI/Chat/ChatFollowUpBar.swift` — in `NatureActionButtonStyle.makeBody`, after `.shadow(color: .black.opacity(0.25), radius: 3, y: 1)`, add:
   ```swift
   .scaleEffect(configuration.isPressed && !Motion.reduceMotion ? 0.97 : 1)
   .animation(Motion.feedback, value: configuration.isPressed)
   ```
2. `apps/mac/Sources/SergeCodeMac/UI/Shell/VcsToolbar.swift` — in `VcsMergePillButtonStyle.makeBody`, after `.shadow(color: .black.opacity(0.2), radius: 2, y: 1)`, add the same two modifiers.

## Boundaries

- Do NOT touch any other file or any other ButtonStyle usage (`.buttonStyle(.plain)` sites stay as they are).
- Do NOT change the pressed fill-opacity values (0.78/0.94 and 0.75/0.92) — they become animated, not replaced.
- Do NOT add scale values other than 0.97, and do NOT invent new curves or durations.
- Do NOT add new dependencies.
- If the code at these locations doesn't match the excerpts above (drift since commit 774d2f560), STOP and report instead of improvising.

## Verification

- **Mechanical**: `swift build --package-path apps/mac` succeeds.
- **Feel check** (use the `apps/mac:verify` skill — mock backend + UIProbe — or run the app):
  - Press and hold a follow-up button under a finished turn: it settles to 97% scale with a fast-then-soft ease; release springs it back. No lag before movement starts (curve is ease-out — starts fast).
  - Rapidly click several times: the scale retargets smoothly, never snapping to either end state.
  - Enable System Settings → Accessibility → Display → Reduce Motion: pressing still dims the fill (animated fade), but nothing scales.
- **Done when**: both styles animate press state via `Motion.feedback`, scale is Reduce-Motion-gated, and the build passes.
