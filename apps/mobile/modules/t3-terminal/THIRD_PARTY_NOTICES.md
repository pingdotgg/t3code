# Third-Party Notices

## Ghostty / libghostty

The iOS terminal renderer vendors `GhosttyKit.xcframework`, a libghostty build produced from T3's
iOS 16 support fork. That fork was created from VVTerm's custom-I/O Ghostty fork.

- Upstream project: https://github.com/ghostty-org/ghostty
- Custom-I/O base fork: https://github.com/wiedymi/ghostty/tree/custom-io
- Vendored source fork: https://github.com/Yash-Singh1/ghostty/tree/custom-io
- Vendored revision: `d36c3b8dffd0d756dd5e5f4933962f774a0e6753`
- Reference integration: https://github.com/vivy-company/vvterm
- License: MIT

Ghostty's MIT license applies to the vendored framework. Keep this notice in sync when updating
`Vendor/libghostty`.

## Ghostty / libghostty-vt

The Android terminal renderer vendors upstream `libghostty-vt` shared libraries and C headers.

- Upstream project: https://github.com/ghostty-org/ghostty
- Vendored revision: `9f62873bf195e4d8a762d768a1405a5f2f7b1697`
- License: MIT

Ghostty's MIT license applies to the vendored Android libraries. Keep this notice in sync when
updating `Vendor/libghostty-vt`.

## MesloLGS NF (Android terminal font)

- Files: `android/src/main/assets/fonts/MesloLGS-NF-{Regular,Bold}.ttf`
- Source: https://github.com/romkatv/powerlevel10k-media (Meslo LG patched with Nerd Fonts glyphs)
- Upstream: Meslo LG by André Berg (customization of Apple's Menlo), Nerd Fonts patcher
- License: Apache License 2.0
