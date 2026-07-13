# Dark-Consistent Liquid Glass Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every production SurgeCode macOS window render with the established dark appearance regardless of macOS system mode, while removing the opaque inner composer rectangle.

**Architecture:** Keep SwiftUI semantic colors and existing Liquid Glass usage, but inject `.dark` at the app's SwiftUI roots and set `NSAppearance(named: .darkAqua)` on AppKit-hosted production windows. Add one reusable `DarkAppearanceConfigurator` alongside existing window configuration code. Remove only the composer editor fill; preserve opaque backgrounds for long-form reading surfaces and intentional white QR/brand treatments.

**Tech Stack:** Swift 6, SwiftUI macOS 26+, AppKit, `@UIState`, Swift Package Manager command-line build, apps/mac UIProbe verification.

## Global Constraints

- Never use `@State`, `@Entry`, or `@Animatable`; use `@UIState` and manual conformances.
- Build with `swift build --package-path apps/mac`; do not edit `Package.swift`.
- Liquid Glass: glass for chrome; never behind long-form text/chat bodies/diffs.
- Dark appearance applies to SurgeCode windows only; do not change macOS global appearance.
- Preserve intentional opaque content surfaces and white QR rendering.

---

## Files and Responsibilities

- Modify `apps/mac/Sources/SergeCodeMac/App.swift`: inject dark SwiftUI environment into main and Settings scene roots.
- Modify `apps/mac/Sources/SergeCodeMac/Support/WindowTransparency.swift`: add reusable native window appearance configurator for AppKit-hosted roots.
- Modify `apps/mac/Sources/SergeCodeMac/UI/Settings/SettingsScene.swift`: update appearance copy and apply dark environment/configurator to Settings content.
- Modify `apps/mac/Sources/SergeCodeMac/UI/Composer/ComposerBar.swift`: remove opaque editor fill and replace queued-row light-system fill with dark-safe semantic fill.
- Modify `apps/mac/Sources/SergeCodeMac/UI/Shell/NewSessionSheet.swift`: set dark native appearance on standalone New Session window.
- Modify `apps/mac/Sources/SergeCodeMac/UI/Shell/AboutView.swift`: set dark native appearance on standalone About window.
- Modify `apps/mac/Sources/SergeCodeMac/Support/UIProbe.swift`: apply same appearance to probe-created windows so light-mode verification captures production-equivalent visuals.

## Verification Surface

- `apps/mac:verify` UIProbe captures main chat/composer, Settings, About, and empty states.
- `swift build --package-path apps/mac` validates all production code.
- Existing macOS tests run with the repository-prescribed Swift Testing plugin and rpaths.

---

### Task 1: Add reusable dark native window configurator

**Files:**
- Modify: `apps/mac/Sources/SergeCodeMac/Support/WindowTransparency.swift`

**Interfaces:**
- Produces `DarkAppearanceConfigurator: NSViewRepresentable`, reusable from SwiftUI roots.
- Produces `DarkAppearanceConfigurator.applyAppearance(to:)`, idempotently setting `window.appearance = NSAppearance(named: .darkAqua)`.

- [ ] **Step 1: Add the configurator after `TransparentWindowConfigurator`**

```swift
/// Pins a SwiftUI-hosted NSWindow to SurgeCode's dark visual language without
/// changing macOS's system-wide appearance. Re-applies after AppKit attaches
/// or reparents the hosting view.
struct DarkAppearanceConfigurator: NSViewRepresentable {
    func makeNSView(context: Context) -> NSView {
        let view = WindowProbeView()
        view.onWindowChange = Self.applyAppearance
        return view
    }

    func updateNSView(_ nsView: NSView, context: Context) {
        Self.applyAppearance(to: nsView.window)
    }

    static func applyAppearance(to window: NSWindow?) {
        guard let window else { return }
        let darkAppearance = NSAppearance(named: .darkAqua)
        if window.appearance?.name != darkAppearance?.name {
            window.appearance = darkAppearance
        }
    }
}
```

`WindowProbeView` already reports attachment changes and is file-private only by convention, so the new configurator can reuse it directly.

- [ ] **Step 2: Build the macOS target**

Run: `swift build --package-path apps/mac`

Expected: `Build complete!`

- [ ] **Step 3: Commit reusable configurator**

```bash
git add apps/mac/Sources/SergeCodeMac/Support/WindowTransparency.swift
git commit -m "fix(mac): add dark window appearance configurator" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: Pin main and Settings SwiftUI roots to dark mode

**Files:**
- Modify: `apps/mac/Sources/SergeCodeMac/App.swift:87-135,165-172`
- Modify: `apps/mac/Sources/SergeCodeMac/UI/Settings/SettingsScene.swift:38-77,126-129`

**Interfaces:**
- Main `RootView` and `SettingsScene` render under `.environment(\\.colorScheme, .dark)`.
- `DarkAppearanceConfigurator` keeps AppKit window-level `NSColor` values aligned with SwiftUI semantic colors.

- [ ] **Step 1: Add dark environment and native configurator to main RootView**

Change the main `WindowGroup` content from:

```swift
RootView(multi: multi, scenery: scenery, passport: passport)
    .environment(passport)
```

to:

```swift
RootView(multi: multi, scenery: scenery, passport: passport)
    .environment(passport)
    .environment(\\.colorScheme, .dark)
    .background(DarkAppearanceConfigurator())
```

Keep existing `.tint`, `.containerBackground`, `.background(TransparentWindowConfigurator())`, lifecycle hooks, and tasks unchanged.

Change Settings scene content from:

```swift
SettingsScene(
    model: multi.local,
    scenery: scenery,
    backend: SergeCodeApp.backend,
    passport: passport,
    multi: multi)
```

to:

```swift
SettingsScene(
    model: multi.local,
    scenery: scenery,
    backend: SergeCodeApp.backend,
    passport: passport,
    multi: multi)
.environment(\\.colorScheme, .dark)
.background(DarkAppearanceConfigurator())
```

- [ ] **Step 2: Update Settings appearance label**

Replace:

```swift
LabeledContent("Appearance", value: "Follows System")
    .help("SurgeCode does not offer a manual light/dark override; it follows macOS.")
```

with:

```swift
LabeledContent("Appearance", value: "Dark")
    .help("SurgeCode uses its dark appearance independently of macOS system appearance.")
```

- [ ] **Step 3: Build**

Run: `swift build --package-path apps/mac`

Expected: `Build complete!`

- [ ] **Step 4: Commit root appearance changes**

```bash
git add apps/mac/Sources/SergeCodeMac/App.swift apps/mac/Sources/SergeCodeMac/UI/Settings/SettingsScene.swift
git commit -m "fix(mac): keep app and settings in dark appearance" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: Remove composer inner white box and light-only queued fill

**Files:**
- Modify: `apps/mac/Sources/SergeCodeMac/UI/Composer/ComposerBar.swift:243-256,1090-1097`

**Interfaces:**
- `TextEditor` remains transparent via `.scrollContentBackground(.hidden)` and inherits outer Liquid Glass.
- Queued rows retain readable contrast using `Color.black.opacity(0.22)` in the forced dark appearance.

- [ ] **Step 1: Remove the explicit editor background**

Replace the editor block:

```swift
.scrollContentBackground(.hidden)
// The editor sits inside a glass capsule, but Liquid
// Glass must never render directly behind long-form
// typed text — back the editor itself with an opaque
// fill so glass stays confined to the surrounding
// chrome (buttons, capsule).
.background(
    RoundedRectangle(cornerRadius: 8, style: .continuous)
        .fill(Color(nsColor: .textBackgroundColor))
)
```

with:

```swift
.scrollContentBackground(.hidden)
// Keep editor transparent so the composer remains one continuous
// Liquid Glass surface; the short draft field does not create a
// second light plate inside the outer glass capsule.
```

Do not change editor frame, placeholder, focus, keyboard handling, or outer `.glassEffect`.

- [ ] **Step 2: Make queued row fill dark-safe**

Replace:

```swift
.background(
    failedToSend
        ? AnyShapeStyle(Color.red.opacity(0.12))
        : AnyShapeStyle(Color(nsColor: .textBackgroundColor).opacity(0.9)),
    in: RoundedRectangle(cornerRadius: 8)
)
```

with:

```swift
.background(
    failedToSend
        ? AnyShapeStyle(Color.red.opacity(0.12))
        : AnyShapeStyle(Color.black.opacity(0.22)),
    in: RoundedRectangle(cornerRadius: 8)
)
```

This is a chrome/status row, not long-form reading content; keep it translucent and dark rather than introducing an opaque white system fill.

- [ ] **Step 3: Build**

Run: `swift build --package-path apps/mac`

Expected: `Build complete!`

- [ ] **Step 4: Commit composer fix**

```bash
git add apps/mac/Sources/SergeCodeMac/UI/Composer/ComposerBar.swift
git commit -m "fix(mac): remove inner composer light plate" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: Pin standalone production windows to dark native appearance

**Files:**
- Modify: `apps/mac/Sources/SergeCodeMac/UI/Shell/NewSessionSheet.swift:363-371`
- Modify: `apps/mac/Sources/SergeCodeMac/UI/Shell/AboutView.swift:15-25`

**Interfaces:**
- Standalone AppKit windows use `DarkAppearanceConfigurator.applyAppearance(to:)` immediately after creation.

- [ ] **Step 1: Configure New Session window**

Insert after `let panel = NSWindow(contentViewController: hosting)`:

```swift
DarkAppearanceConfigurator.applyAppearance(to: panel)
```

Leave panel sizing, titlebar, delegate, and activation behavior unchanged.

- [ ] **Step 2: Configure About window**

Insert after `let panel = NSWindow(contentViewController: hosting)`:

```swift
DarkAppearanceConfigurator.applyAppearance(to: panel)
```

- [ ] **Step 3: Build**

Run: `swift build --package-path apps/mac`

Expected: `Build complete!`

- [ ] **Step 4: Commit standalone window changes**

```bash
git add apps/mac/Sources/SergeCodeMac/UI/Shell/NewSessionSheet.swift apps/mac/Sources/SergeCodeMac/UI/Shell/AboutView.swift
git commit -m "fix(mac): pin standalone windows to dark appearance" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: Align UIProbe windows with production appearance

**Files:**
- Modify: `apps/mac/Sources/SergeCodeMac/Support/UIProbe.swift:578-581,873-876,898-901,918-921,950-953`

**Interfaces:**
- Every probe-created `NSWindow` gets `DarkAppearanceConfigurator.applyAppearance(to:)` before capture.

- [ ] **Step 1: Add appearance configuration to probe windows**

After each probe window is created and before it is shown/captured, add:

```swift
DarkAppearanceConfigurator.applyAppearance(to: window)
```

Use the variable's exact name in each block: `window`, `aboutWindow`, or `emptyWindow`. This includes the sidebar, passport/new-session probe, About, empty state, and Settings windows.

- [ ] **Step 2: Build**

Run: `swift build --package-path apps/mac`

Expected: `Build complete!`

- [ ] **Step 3: Commit verification harness alignment**

```bash
git add apps/mac/Sources/SergeCodeMac/Support/UIProbe.swift
git commit -m "test(mac): capture UIProbe windows in dark appearance" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 6: Verify behavior end-to-end

**Files:**
- No source changes expected.

- [ ] **Step 1: Run production build**

Run:

```bash
swift build --package-path apps/mac
```

Expected: `Build complete!`

- [ ] **Step 2: Run macOS tests with required plugin and rpaths**

Run:

```bash
swift test --package-path apps/mac \
  -Xswiftc -plugin-path -Xswiftc /Library/Developer/CommandLineTools/usr/lib/swift/host/plugins/testing \
  -Xlinker -rpath -Xlinker /Library/Developer/CommandLineTools/Library/Developer/Frameworks \
  -Xlinker -rpath -Xlinker /Library/Developer/CommandLineTools/Library/Developer/usr/lib
```

Expected: all selected tests pass. If environment lacks the plugin/framework, report exact failure.

- [ ] **Step 3: Run scoped runtime verification**

Invoke `apps/mac:verify` with a light-system appearance and mock backend. Capture main chat/composer, Settings, About, and empty state.

Expected observations:

- Composer shows one continuous glass surface; no inner white rounded rectangle behind `Message…`.
- Model/runtime/plan controls use dark-mode contrast.
- Settings says `Appearance: Dark`, with dark controls and grouped form.
- About/New Session windows remain dark when macOS system mode is light.
- Intentional QR code remains black-on-white for scanning.

- [ ] **Step 4: Inspect diff and status**

Run: `git status --short && git diff HEAD~5..HEAD --check`

Expected: no whitespace errors; only appearance-related files changed.

- [ ] **Step 5: Mark implementation complete**

Update task tracking after build, tests, and runtime capture all pass. Report any skipped runtime step explicitly.
