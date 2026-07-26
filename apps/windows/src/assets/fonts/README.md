# Geist font (Sans + Mono)

Provenance: vendored from https://github.com/vercel/geist-font release v1.7.2
(static OTFs: `Geist/otf`, `GeistMono/otf`). License: SIL Open Font License 1.1
— see `OFL.txt` in this directory, which must ship with the redistributed font
software.

Bundled faces (PostScript names match filenames): Geist-Regular, Geist-Medium,
Geist-SemiBold, GeistMono-Regular, GeistMono-Medium.

Usage: registered at launch by `SurgeTypography.registerBundledFonts()` (see
`Theme/SurgeTypography.swift`); apply fonts only through those tokens so system
chrome stays on SF and missing faces fall back to system fonts.
