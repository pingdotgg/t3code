# Brand icons

The three Icon Composer projects are the source of truth for full application icons:

- `dev/app-icon.icon`
- `nightly/app-icon.icon`
- `prod/app-icon.icon`

Each project uses `text.svg` for the T3 mark and `background.svg` when the background is a vector layer. Additional layers use semantic names that describe their role and placement.

Run `vp run icons:export` from the repository root to regenerate the tracked PNG and ICO assets for mobile, desktop, and web. Run `vp run icons:check` to verify that the generated assets match their sources without changing files.

Exporting requires Icon Composer 2 or newer on macOS. The script selects the newest compatible exporter from Xcode or a standalone Icon Composer installation and pins design generation 26. Set `ICON_COMPOSER_TOOL` to the full path of `Icon Composer.app/Contents/Executables/ictool` to override automatic discovery.

Do not edit the generated PNG or ICO files directly.
