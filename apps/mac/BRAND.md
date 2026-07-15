# SurgeCode brand guide

## Name

Use **SurgeCode** in all user-facing copy. The internal identifiers that intentionally remain **SergeCode** are the bundle id `com.sergeserb.sergecode`, targets `SergeCodeMac` and `SergeCodeApp`, the app-support directory `~/Library/Application Support/SergeCode/`, and the sidecar `client_label = "SergeCode"`. They preserve migration and protocol stability across the hard fork.

## Mark

The primary mark is `passportPeak`: a stamp ring enclosing twin peaks, tied to the Passport feature. `surgePeak` and `notchPeak` remain in code as unshipped explorations. Use the mark in the About window and empty state. Do not use it in the sidebar, toolbars, sheets, or Settings. Minimum size is 16pt. Clear space is 25% of the mark width on every side.

## Palette

- Alpine moss accent: `#4C7559` (`AlpineTheme.accent`)
- Snow: `#F2F7FB`
- `dolomitesGradientPairs` duotones: dawn limestone, glacier melt, high meadow, larch dusk, scree, spruce shade

Photo-derived scenery may add a dynamic tint. Gradient washes remain the deterministic fallback when photos or an Unsplash key are unavailable.

## Wordmark

SF Pro Rounded semibold, with tracking −0.5 at the 34pt reference size, in a single color. `BrandWordmark` is the only sanctioned implementation.

## Typography

Display uses SF Pro Rounded via `.system(design: .rounded)` on brand surfaces. Body and UI use the system default. No fonts are bundled.

## App icon

Generate the single blue app icon with `scripts/generate-appicon.swift` from `BrandMarkGeometry`. All build configurations use `Support/AppIcon.icns`; the Icon Composer source is `Support/AppIcon.icon/`.

## Voice

Concise, calm, alpine. Use second person. Do not use exclamation marks. Use sentence case.
