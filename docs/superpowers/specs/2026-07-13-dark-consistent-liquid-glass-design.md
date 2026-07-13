# Dark-Consistent Liquid Glass Design

## Goal

Make SurgeCode's macOS UI render consistently with its established dark-mode appearance even when macOS itself is in light mode. Remove the opaque inner composer editor box so the composer remains one continuous Liquid Glass surface.

## Scope

- Force `.dark` color scheme at the app's SwiftUI scene roots.
- Remove the `TextEditor` opaque `NSColor.textBackgroundColor` fill from `ComposerBar`.
- Replace accidental light-system fills in composer-adjacent transient rows with dark-safe semantic fills.
- Leave intentional opaque long-form content surfaces and white accent treatments unchanged.

## Design

`SergeCodeApp` applies `.environment(\\.colorScheme, .dark)` to the main `RootView` and `SettingsScene`. This changes only SurgeCode's rendered appearance; macOS system appearance remains unchanged.

`ComposerBar` keeps `.scrollContentBackground(.hidden)` and uses no editor background. Its controls and editor sit directly inside the existing `GlassEffectContainer` and outer `.glassEffect(.regular, ...)`, producing one clear glass capsule. Placeholder and typed text retain standard dark-scheme semantic colors.

Queued composer rows use semantic dark translucent fills rather than `NSColor.textBackgroundColor`, preventing isolated light rectangles while retaining readability. Other opaque surfaces used for long-form text remain opaque per the macOS Liquid Glass architecture rule.

## Verification

1. Build with `swift build --package-path apps/mac`.
2. Run the mock UI probe under a light system appearance.
3. Confirm composer has no inner white rectangle, controls retain dark-mode contrast, and settings/main window both render dark.
4. Run relevant macOS tests if build succeeds.
