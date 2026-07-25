# 009 — Sidebar & shell polish: disclosure curves, hover washes, status eases (mac)

- **Status**: DONE
- **Commit**: c9013c976
- **Severity**: MEDIUM
- **Category**: Easing & duration / cohesion / missed opportunities
- **Estimated scope**: 4 files, ~55 lines

## Problem

1. **Structural disclosures run on the 0.14s press-feedback curve** — `Motion.feedback` is documented for "pointer-driven press feedback and small icon changes"; `Motion.structure` owns "occasional panels, disclosures, and intentional layout changes" (`Motion.swift:50-56` vs `:64-67`). Three sidebar disclosures use the wrong one: `settledDisclosure` (`SidebarView.swift:297`), `toggleProjectCollapse` (`SidebarView.swift:482`), and `.animation(Motion.feedback, value: isCollapsed)` (`SidebarView.swift:856`).
2. **"Show N more" pops rows in** — `SidebarView.swift:271`: `expandedProjects.insert(group.id)` with no animation.
3. **Disclosure chevrons hard-swap glyphs** — `SidebarView.swift:306` and `:783` swap `chevron.right`/`chevron.down` with no `.contentTransition`, while the thread-status icon 250 lines away has the RM-gated `.symbolEffect(.replace)` idiom (`:1052-1053`).
4. **Connections footer teleports** — status dots (`:1110-1112`) snap color on connect/disconnect with no `Motion.ambient` ease (the same kind of tint is animated in `ConnectionStatusPill.swift:27`), and the footer row has no hover wash (`:1127-1131` shows only an unanimated `isPresented` fill).
5. **EmptyStateView press scale ignores Reduce Motion** — `EmptyStateView.swift:162`: `.scaleEffect(configuration.isPressed ? 0.97 : 1)` still scales under Reduce Motion, contradicting `Motion.swift:28-30` ("nothing … scales").
6. **NewSessionSheet project rows teleport** — `NewSessionSheet.swift:371-382`: checkmark and accent selection fill change with no animation; rows have no hover wash — while `ComposerPickerChoiceRow` animates both (`ComposerPickerComponents.swift:160-164`).
7. **Provider-readiness label pops** — `NewSessionSheet.swift:153-158` has `.transition(.opacity)` driven only by `.animation(Motion.reveal, value: errorMessage == nil)` (`:179`); a readiness message appearing on provider change pops in and shoves the button row.
8. **Stale comment** — `ContentView.swift:41-42` claims thread switches "cross-fade inside ChatScreen"; `ChatScreen.swift:95-96` documents the opposite (immediate render — correct, keyboard-frequency). Comment only.

## Target

```swift
// target — SidebarView.swift:297 and :482
withAnimation(Motion.structure) { … }

// target — SidebarView.swift:856
.animation(Motion.structure, value: isCollapsed)

// target — SidebarView.swift:270-272 ("Show N more")
Button {
    withAnimation(Motion.structure) {
        expandedProjects.insert(group.id)
    }
} label: { … }

// target — SidebarView.swift:306 and :783 chevrons
Image(systemName: isRevealed ? "chevron.down" : "chevron.right")
    // …existing modifiers…
    .contentTransition(Motion.reduceMotion ? .identity : .symbolEffect(.replace))
```

```swift
// target — SidebarConnectionsFooter (SidebarView.swift:1089-1138)
// dots: ease tint changes on the ambient curve (key on an Equatable
// connection descriptor available on `location.connection`, e.g. its status;
// inspect the type and pick the Equatable key — do not key on Color)
Circle()
    .fill(location.connection.statusColor)
    .frame(width: 5, height: 5)
    .animation(Motion.ambient, value: <Equatable connection status key>)
    .accessibilityHidden(true)

// footer row: hover wash + eased pressed/selected fill
@UIState private var isHovering = false
// …inside the Button label…
.background {
    if isPresented || isHovering {
        Rectangle().fill(Color.primary.opacity(isPresented ? 0.055 : 0.04))
    }
}
// …
.onHover { isHovering = $0 }
.animation(Motion.feedback, value: isHovering)
.animation(Motion.feedback, value: isPresented)
```

```swift
// target — EmptyStateView.swift:162
.scaleEffect(configuration.isPressed && !Motion.reduceMotion ? 0.97 : 1)
```

```swift
// target — NewSessionSheet.swift: extract the project row into a private
// ProjectChoiceRow view (per-row hover state), mirroring the
// ComposerPickerChoiceRow idiom (ComposerPickerComponents.swift:160-164):
private struct ProjectChoiceRow: View {
    let project: <element type of filteredProjects>
    let isSelected: Bool
    let onSelect: () -> Void

    @UIState private var isHovering = false

    var body: some View {
        Button(action: onSelect) {
            HStack(spacing: 10) {
                Image(systemName: "folder")
                    .foregroundStyle(.secondary)
                    .frame(width: 16)
                VStack(alignment: .leading, spacing: 2) {
                    Text(project.name).foregroundStyle(.primary).lineLimit(1)
                    Text(project.path)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                Spacer(minLength: 8)
                if isSelected {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundStyle(AlpineTheme.accent)
                        .transition(.opacity)
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 7)
            .contentShape(Rectangle())
            .background(
                isSelected ? AlpineTheme.accent.opacity(0.12)
                    : isHovering ? Color.primary.opacity(0.06) : Color.clear,
                in: RoundedRectangle(cornerRadius: 8))
        }
        .buttonStyle(.plain)
        .onHover { isHovering = $0 }
        .animation(Motion.feedback, value: isHovering)
        .animation(Motion.feedback, value: isSelected)
        .accessibilityLabel("\(project.name), \(project.path)")
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }
}
// call site (NewSessionSheet.swift:352-388) becomes:
ForEach(filteredProjects) { project in
    ProjectChoiceRow(
        project: project,
        isSelected: selectedProjectID == project.id
    ) {
        selectedProjectID = project.id
    }
}
```

```swift
// target — NewSessionSheet.swift:179, add immediately after the errorMessage line
.animation(Motion.reveal, value: providerReadinessMessage == nil)

// target — ContentView.swift:41-42 comment
// Keyed to presence, not thread id — thread → thread switches render
// immediately inside ChatScreen (frequent, often keyboard-driven); this
// only covers hero ↔ chat.
```

## Repo conventions to follow

- Curves only from `Theme/Motion.swift`: `Motion.structure` (disclosures), `Motion.feedback` (hover/press), `Motion.ambient` (status tints), `Motion.reveal` (message arrival).
- The symbol-replace idiom with Reduce-Motion gate: `SidebarView.swift:1052-1053`.
- The hover-wash idiom: `SidebarView.swift:750-760` (fill + `.onHover` + `.animation(Motion.feedback, value: isHovering)`).
- `Motion.structure` animates the List row insertions/removals from steps 1–2 natively — do NOT add `.transition` modifiers to sidebar List rows.

## Steps

1. `apps/mac/Sources/SergeCodeMac/UI/Shell/SidebarView.swift` — swap `Motion.feedback` → `Motion.structure` at `:297` and `:482`; swap the `isCollapsed` animation at `:856`; wrap the "Show N more" insert (`:271`) in `withAnimation(Motion.structure)`; add the RM-gated `.contentTransition(.symbolEffect(.replace))` to the chevrons at `:306` and `:783`; apply the footer Target (inspect `location.connection`'s type and key the dot animation on an Equatable status — never on `Color`).
2. `apps/mac/Sources/SergeCodeMac/UI/Shell/EmptyStateView.swift:162` — apply the Reduce-Motion gate.
3. `apps/mac/Sources/SergeCodeMac/UI/Shell/NewSessionSheet.swift` — extract `ProjectChoiceRow` per the Target (keep the exact current layout/a11y), rewrite the `:352-388` call site, and add the `providerReadinessMessage` animation after `:179`.
4. `apps/mac/Sources/SergeCodeMac/ContentView.swift:41-42` — apply the comment Target.

## Boundaries

- Do NOT touch thread-row hover/selection (`List(selection:)` behavior is native and correct).
- Do NOT add transitions inside the sidebar `List`; the curve swap + `withAnimation` drives row inserts.
- Do NOT change any disclosure's expanded/collapsed logic or persistence (`saveCollapsedProjects` etc.).
- If a step doesn't match the code you find (drift since commit c9013c976), STOP and report instead of improvising.

## Verification

- **Mechanical**: `swift build --package-path apps/mac` succeeds, then `vp check` and `vp run typecheck` pass.
- **Feel check**:
  - Collapse/expand a project and the Settled group: rows glide on the 0.24s structure curve (visibly calmer than before); chevrons morph instead of swapping.
  - "Show N more": hidden rows ease in.
  - Hover the Connections footer: subtle wash fades in; dots ease between colors on connect/disconnect.
  - Reduce Motion on: empty-state action cards no longer scale on press (fill/opacity feedback remains).
  - New Session sheet: project rows wash on hover, selection fill eases, checkmark fades; switch providers and watch the readiness label fade in without shoving the buttons.
- **Done when**: all eight seams behave as targeted and the build passes.
