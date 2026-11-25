# tix brand icons

The [mammoth SVG](prod/app-icon.icon/Assets/mammoth.svg) is the master artwork. All release channels use the same Icon Composer project. Legacy export filenames remain stable so existing packaging and update scripts can find them.

- Run `vp run icons:export` on macOS with Icon Composer 2 or newer to regenerate the iOS, Linux, Windows, and web icons and copy development web icons into `apps/web/public`. Use `vp run icons:check` to check for stale exports.
- Run `vp run icons:export:android` to regenerate the adaptive foreground, themed icon, notification silhouette, and splash icons from the same artwork.
- For macOS, export the shared project in Icon Composer with **macOS pre-Tahoe**, **Default**, **1024pt**, and **1×**. Use the same export for `dev/blueprint-macos-1024.png`, `nightly/nightly-macos-1024.png`, and `prod/black-macos-1024.png`. Preserve the 824×824 icon body inside the 1024×1024 canvas.
