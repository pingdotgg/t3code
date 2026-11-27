# SnapShots

Capture any window on your desktop—along with its app name, window title, and accessibility text/controls—and attach it directly to your current draft so agents can reason about what's on screen.

Available in the desktop app on **macOS**, **Windows**, and **Linux (Wayland)** (X11 is not supported). Off by default.

## Setup and usage

1. Enable **Settings → SnapShots** and complete the platform permission and shortcut steps.
   - **macOS**: Requires Screen Recording (and Accessibility only if **Include app text** is enabled).
   - **Windows**: No extra permissions required.
   - **Linux (Wayland)**: Uses a compositor-specific helper/extension (see below).
2. Switch to any window and press the shortcut (default on macOS/Windows: **both Shift keys together**). T3 Code attaches the capture to your active draft (or starts a new draft) and brings itself to the front.

- **Include app text**: Toggle in **Settings → SnapShots** to include or omit accessibility tree data (not every app exposes document/terminal contents; slow apps fall back to screenshot-only).
- **Sound, flash, and animation**: Each can be toggled independently in Settings.
- **Customize shortcut**: Pick a modifier pair (macOS/Windows) or key chord in Settings (Linux uses key chords only).

## Linux Wayland desktops

- **GNOME**: Installs the per-user **T3 Code SnapShots** extension (sign out and back in once to enable it; revoke via GNOME Extensions).
- **KDE Plasma 6**: Installs the bundled capture helper (manage shortcuts in **System Settings → Keyboard → Shortcuts**; remove via **Manage capture → Access → Advanced**).
- **Hyprland / Omarchy**: Installs the helper and previews the exact config binding before saving a backup and reloading (approve screen-sharing if prompted).
- **Niri**: Previews, validates, and adds the binding to your Niri config (requires `gdbus`).
- **Other Wayland desktops**: Uses the screenshot portal or falls back to a manual window picker (without accessibility data). XWayland windows inside Wayland are supported.
