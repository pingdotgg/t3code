# Linux window capture

Wayland only. Each capture picks one backend in `LinuxSnapShot.ts` (Hyprland helper, Niri IPC, KDE
helper, Screenshot portal with active-window target, GNOME extension, then the Electron picker) and
never falls back to another on failure, cancellation, or denial. A stale `NIRI_SOCKET` or a reachable
GNOME extension must not select another desktop's backend; session detection comes from
`XDG_CURRENT_DESKTOP`, in `linuxCaptureSession.ts`.

## Module boundaries

`dbus-next` must only be reached through dynamic imports. `linuxCaptureSession.ts` holds the pure
helpers (session detection, Niri binding text, portal key mapping, PNG reading) so the main process
can answer "which desktop is this" without loading a D-Bus client on macOS or Windows.

`patches/dbus-next@0.10.2.patch` removes `usocket` (its optional native Unix-FD transport) and
connects to both `unix:path=` and `unix:abstract=` buses through Node's `net`. We never pass Unix
descriptors, and upstream had no `net` fallback for abstract sockets, which `dbus-launch` produces
outside systemd. Keep the patch when bumping `dbus-next`.

## Accessibility identity

The Screenshot portal returns a PNG URI and no window identity, so portal and picker captures carry
no accessibility data. Do not infer it from the subsequently focused window or a guessed title.

Native backends supply PID, title, and frame. AT-SPI matching is by PID plus a unique title and size
match. AT-SPI reports `(0, 0)` for a window's screen position on Wayland even when the compositor
knows the real one, so only width and height are compared, and descendant coordinates are trusted
only when the AT-SPI root agrees with the compositor frame and at least one descendant reports a
distinct position. Otherwise bounds are `null` rather than zero-origin rectangles.

Title matching ignores a single leading Braille CLI spinner frame, since terminals change it between
capture and lookup. KDE supplies both `frameGeometry` and `clientGeometry`; accept either verified
size, never a decoration-height tolerance.

On GNOME, browser accessibility bridges need `org.gnome.desktop.interface toolkit-accessibility`
before the browser starts. Do not toggle it during capture.

## KDE

KWin authorizes `org.kde.KWin.ScreenShot2` by resolving the calling PID's executable against its
application registry, so the helper is installed at a stable path under the XDG data home with a
hidden desktop entry, not run from the AppImage mount. Two traps:

- `X-KDE-DBUS-Restricted-Interfaces` uses KConfig's comma-separated list syntax. A trailing
  semicolon becomes part of the interface name and KWin rejects it.
- KService's cache key includes search paths and locale. Refresh with `kbuildsycoca6` both directly
  and through `systemd-run --user`; refreshing only inside the AppImage environment can leave KWin
  reading stale permissions.

Readiness is checked by calling `CaptureWindow` with an invalid ID and expecting `InvalidWindow`,
which runs after KWin's authorization check. Files on disk alone never mean ready.

Plasma consumes Shift for shifted digits and produces a punctuation keysym, so a successfully bound
`Ctrl+Shift+2` may never fire on some layouts. Letter chords work around it. A general fix needs
layout-aware encoding.

## Hyprland

The helper maps a foreign-toplevel handle to the full 64-bit window address with
`hyprland-toplevel-mapping-v1` before exporting through `hyprland-toplevel-export-v1`. Never
truncate the address or pick a window by title.

Hyprland 0.56.2 renders an access-denied texture instead of failing the export frame when consent
is rejected or a `no_screen_share` rule applies. `ready` is not a permission grant, and pixels must
not be inspected to guess one. See
[ScreenshareFrame](https://github.com/hyprwm/Hyprland/blob/v0.56.2/src/managers/screenshare/ScreenshareFrame.cpp).

Hyprland's GlobalShortcuts portal registers actions, not key chords. `shortcutActionRegistered` is
distinct from `shortcutRegistered`; nothing in the UI may claim the keys are reserved.

The bundled protocol XML ships with the helper because its BSD license requires the notice.

## Niri

Niri does not implement the global-shortcut portal. While capture is enabled the app owns
`<app-id>.SnapShot` on the session bus and exports `com.t3tools.SnapShot.Capture`; the config
binding spawns `gdbus` to call it. Development and packaged app IDs use separate names so a dev
build does not steal the user's binding.

Niri supplies no global screenshot origin, so AT-SPI matching uses logical size and title only.

## Config edits

`CaptureShortcutConfig` edits user dotfiles. The invariants: opening setup never reads the file;
**Review changes** is the read consent; the renderer only ever sees before/after text over trusted
desktop IPC; **Save** sends a proposal ID and the desktop re-verifies bytes, inode, mode, and
includes against the snapshot it previewed before writing. Writes go through a staged temp file and
atomic rename with a backup beside the original. Niri validates the staged file first.

Modifier serialization writes Linux `Ctrl` explicitly, never the cross-platform `mod` alias.

## GNOME extension

Source in `apps/desktop/gnome-extension`, UUID `snap-shot@t3.codes`. GNOME only discovers a newly
installed extension at login, so setup distinguishes "installed, needs logout" from "discovered but
disabled" and compares loaded and installed versions.

The extension trusts callers that own `com.t3tools.T3Code.SnapShot` (or the `.Development`
variant) on the same connection. This is GNOME's trusted-session-client pattern, not authentication
against a hostile process on the user's bus.

Electron does not position overlay windows on Wayland, so the flash and flight run as Shell actors
inside the extension with coordinates relative to T3's content area. Electron 44's restored-session
path can skip rebinding and leave callbacks behind on unregister, which is why
`PortalCaptureShortcut` owns its own portal session instead of using Electron's global-shortcut API.

GNOME 50 removed `Meta.is_wayland_compositor`. Shell internals change across majors; verify each
version before adding it to `metadata.json`.
