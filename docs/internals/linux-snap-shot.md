# Linux window capture

Linux window capture supports Wayland sessions only. This does not remove X11 support from the
Electron app itself. Windows captures the active window through the native region-capture adapter,
using the window bounds without enumerating desktop thumbnails, and uses native modifier hooks.
macOS retains its native capture path.

`apps/desktop/src/snapShot/LinuxSnapShot.ts` selects a backend for each capture:

1. A Hyprland session: use the installed bundled native window-export helper.
2. A Niri session with `NIRI_SOCKET`: capture through Niri's native IPC (25.11 or newer).
3. A KDE session with KWin ScreenShot2 version >= 2: use the bundled native capture helper.
4. Screenshot portal interface version >= 3 **and** `AvailableTargets & 8`: request `target=8`
   (active window), `interactive=false`. Version alone is insufficient. This does not bypass consent.
5. In a GNOME session, extension protocol version 1 or 2: capture the focused window actor without a picker.
6. None available: the existing Electron/PipeWire picker, explicitly described as manual capture.

Failures, cancellation, timeouts, and permission denial do not select a different backend. All
entry points go through `DesktopSnapShot.captureSource`. The optional `linuxBackend` IPC
state distinguishes this choice from `mode=portal`, which continues to control Wayland shortcut
registration. The global-shortcut portal and screenshot permission are independent.

Source selection is shared desktop policy. Global shortcuts capture the foreground window in place,
including T3 Code; they do not hide the real source window. The command-palette action temporarily
hides focused T3 to target the previous app. Both use the same backend, persistence, and animation
path. Native helpers do not exclude T3 or hide it to take a screenshot. After capture, call native
feedback activation even for self-capture: it also establishes the destination for the flight.

The shared capture gate covers taking pixels and the initial foreground handoff. It releases
before accessibility results and attachment persistence finish, so those can complete independently
for each capture ID. Before another snapshot, dismiss the previous native effects so they cannot
appear in its pixels. Completion notifications are passive; a late persistence failure dismisses
only its capture's renderer animation and does not refocus T3 or cancel a newer capture.

Capture preferences are shared across desktops, but access is derived from the current session,
not a persisted onboarding-completed flag. The optional `linuxDesktop` IPC field identifies GNOME,
KDE, Niri, or Hyprland independently of a successful capability probe, so setup can name the desktop even
on failure. Relaunching resets shortcut verification and rechecks access; it does not remove other
desktops' helpers or bindings. A stale `NIRI_SOCKET` or reachable GNOME extension must not select
another desktop's native backend.

The standard API returns a PNG URI only, not a stable window identity. Do not infer accessibility
context from the subsequently focused window or a guessed title. Extension metadata contains the
captured window's PID, title, frame bounds, and desktop app ID. The existing bounded accessibility
reader attempts an AT-SPI element-tree lookup by PID and requires a unique title/size match on
Wayland. Element bounds are converted from the matched AT-SPI window into captured-image pixels.
Wayland locations are trusted only when the AT-SPI root position agrees with the compositor's
captured frame and at least one descendant reports a distinct position. Otherwise the known root
covers the image and descendant bounds are `null` rather than misleading zero-origin rectangles.
Anonymous empty groups are removed and anonymous single-child group chains are collapsed before
applying the payload limit. The legacy flattened text is retained for mixed-version clients, while
new provider prompts prefer the structured tree. Provider prompts use a compact projection that
omits unavailable bounds and default fields, flattens remaining anonymous groups, removes empty
structural nodes and duplicate labels, and retains meaningful state, actions, and coordinates. The
stored attachment remains lossless so the client can show the original tree.
When `snapShotIncludeAccessibility` is disabled, capture does not start the accessibility helper
or perform an AT-SPI lookup. The image capture and feedback paths are otherwise unchanged.
Title matching ignores a single leading Braille CLI spinner followed by whitespace, since terminal
apps can change its frame between capture and lookup. The remaining title must be nonempty and match
exactly. This normalization also applies when checking ambiguity; an exact spinner frame does not
take precedence over another window with the same normalized title and size.
AT-SPI can report `(0, 0)` for a window's screen position even when the compositor knows its real
position, so only width and height are compared (within two logical pixels). Both captured title
sources are accepted, and one active match can disambiguate otherwise identical windows. Remaining
ambiguous matches are rejected; macOS and Windows continue to require matching position as well as
size. Sandboxed
apps, scaling differences, and incomplete accessibility providers can make that lookup fail; the image
still succeeds. Electron does not position window overlays on Wayland; extension v2 uses Shell actors.

Accessibility reads begin before any restoration or activation of T3 Code and return as soon
as they finish, with a shared three-second deadline on all desktop platforms. This accommodates larger browser trees without adding a fixed delay to fast
reads. On timeout, capture uses completed flat text or a partial bounded tree when available, then
continues without accessibility data otherwise. Within each capture worker, no further accessibility
read starts until its outstanding native read settles; separate captures have independent workers
and can read concurrently.

On GNOME, browser accessibility bridges may require `org.gnome.desktop.interface toolkit-accessibility`
to be enabled before the browser starts. This is separate from `screen-reader-enabled` and screenshot
permission. Do not change the desktop setting implicitly during capture. Even with the bridge enabled,
apps may expose only window controls rather than their main content; Ghostty 1.3.1's GTK terminal surface
does not implement the accessible-text interface.

## D-Bus lifetime

Each discovery/capture owns a short-lived session-bus connection. Unsandboxed clients register
their desktop app ID with `org.freedesktop.host.portal.Registry` before accessing portal APIs.
The connection owns the request until the response or timeout. The signal match is installed
before `Screenshot`, and responses arriving before the method reply are retained. Signals must
come from the portal's unique owner and this connection's request namespace. Failed pending
requests are closed; disconnecting removes matches and temporary names.

PNG reads accept local file URIs only and are bounded to 32 MiB. Portal-owned files are not removed.
Images are fitted within 2560×1600 while preserving aspect ratio. The Electron D-Bus client uses
`dbus-next` without its optional native Unix-FD dependency. KDE's dedicated Rust helper uses
`zbus` to pass a writable Unix descriptor to KWin and read raw pixels, bounded to 128 MiB.

## KDE Plasma

`KdeSnapShot.ts` integrates `native/kde-snap-shot`, built and shipped as a Linux-only
extra resource. Development builds need `cargo build --locked --release --manifest-path
native/kde-snap-shot/Cargo.toml` first. The helper requests KWin's native ScreenShot2 API,
not the Screenshot portal; no Spectacle subprocess, shell replacement, or disabled permission
checks are involved. This integration targets Plasma 6 and its `kbuildsycoca6` registry tool.

The access step explicitly installs the bundled executable below the XDG data home at
`t3code/kde-capture/t3-kde-snap-shot`, and registers a hidden application desktop entry
declaring only `org.kde.KWin.ScreenShot2` in `X-KDE-DBUS-Restricted-Interfaces`. Its Exec points
to the installed helper, not an AppImage path or a shared interpreter. KWin resolves the calling
PID's executable and matches that against its application registry. Setup refreshes that registry
with `kbuildsycoca6`, then checks authorization without capturing: `CaptureWindow` with an invalid
window identifier must return `InvalidWindow`, which follows KWin's authorization check.
Having files on disk alone is never reported as ready. Bundle changes require an explicit update.
Setup also offers removal, deleting only T3's helper executable and capture desktop entry.
The restricted-interface property uses KConfig's comma-separated list syntax, not XDG's semicolons.
For our single interface, write the exact name with no trailing separator; a semicolon becomes
part of the permission name and KWin rejects it. Existing malformed entries require an explicit
helper update, even when the bundled executable is unchanged.
Desktop-entry updates use an atomic rename so directory watchers observe them. Installation and
removal refresh KService both directly and, when available, through `systemd-run --user` in the
Plasma session environment. KService's cache key includes search paths and locale; refreshing
only inside an AppImage can leave KWin reading stale permissions from a different cache. No
environment is imported into the user manager, and non-systemd sessions retain the direct refresh.

One-shot KWin scripts obtain the focused window's ID/PID/title/frame and later activate only
the matching T3 process and title. Replies must come from KWin's unique bus owner; scripts are
unloaded after use. If command-palette capture remaps T3, activation awaits it using window/title
signals with a deadline, not polling. Capture pins the discovered ID, then checks identity again
before attaching metadata for AT-SPI. This comparison ignores a changing leading CLI spinner, like the AT-SPI title matcher,
but still requires the same non-spinner title, ID, process, app identity, and frame. The original
capture-time metadata is preserved for the attachment and compositor effects. If scripting is
unavailable, the native active-window screenshot still works but
has no accessibility identity. Changed or closed windows never contribute text from a replacement.
Focus failure does not discard an image.

KDE metadata includes both `frameGeometry` (the screenshot, including decorations) and
`clientGeometry` (the app area). AT-SPI matching accepts either verified size, never an arbitrary
decoration-height tolerance, and rejects ambiguity across both candidates. When accessible screen
positions are reliable, element coordinates map against the screenshot frame so the title-bar offset
is preserved. When an app reports only `(0, 0)` or repeats the root origin for every element,
text/structure can still be included but descendant coordinates remain `null`.

The same executable embeds a short-lived QML capture overlay loaded through KWin's
`loadDeclarativeScript`; there is no persistent effect package to install or enable. The access
check reports whether that API exists, and Settings enables effects only with an up-to-date,
authorized helper. `kreadconfig6` reads KDE's layered `AnimationDurationFactor`; zero disables
flight, in addition to Electron's reduced-motion policy. An unavailable effect never fails capture.

Each output gets an input-transparent KWin internal window (`outputOnly`, no focus, no shadow),
showing the frozen PNG, not moving the real application. QML transitions run only for flash and
flight, with no per-frame JS or idle animation. Source and destination use compositor logical
coordinates; the normalized composer target maps through the exact PID/title's client geometry.
An authenticated KWin callback confirms the first painted frame and landing. Private helper stdin
feeds an asynchronous D-Bus command channel (no polling). The landed image stays until the
renderer acknowledges the attachment. Cancellation, screen lock, output/desktop changes, owner
loss, and bounded deadlines hide the overlay, unload its script, and delete private PNG/QML files.

The native helper's tests use a private D-Bus daemon to exercise authorization replies, unsigned
version properties, Unix-FD pixel transport, PNG conversion, identity changes, and script cleanup.
KWin's `Version` property is a D-Bus `u` (`uint32`), decoded as `UIntVariant` in the desktop and
`u32` in the native helper. The desktop transport fixture also sends that unsigned wire type.
Run `cargo test --locked --manifest-path native/kde-snap-shot/Cargo.toml` on Linux with
`dbus-daemon` installed. These tests do not prove real Plasma authorization, mixed-DPI capture,
or focus behavior; validate those in a Plasma session before declaring runtime support verified.
With Qt 6's QML test tools installed, run the overlay state-machine tests without a desktop:

```sh
QT_QPA_PLATFORM=offscreen QT_QUICK_BACKEND=software qmltestrunner \
  -import native/kde-snap-shot/tests/qml/imports \
  -input native/kde-snap-shot/tests/qml
```

These execute the shipped QML with a fake KWin module. A live Plasma pass still needs to verify
placement, stacking, multi-output scaling, focus, and reduced motion with the compositor.

Upstream contracts: [KWin ScreenShot2](https://github.com/KDE/kwin/blob/v6.6.6/src/plugins/screenshot/screenshotdbusinterface2.cpp),
[executable authorization](https://github.com/KDE/kwin/blob/v6.6.6/src/utils/serviceutils.h),
[KWin scripting](https://develop.kde.org/docs/plasma/kwin/api/),
[internal-window input/geometry behavior](https://github.com/KDE/kwin/blob/v6.6.6/src/internalwindow.cpp),
[QML loader and D-Bus calls](https://github.com/KDE/kwin/blob/v6.6.6/src/scripting/scripting.cpp).

## Hyprland

`HyprlandSnapShot.ts` uses `native/hyprland-snap-shot`, built and shipped on Linux for
x64 and arm64. Setup explicitly installs it at `$XDG_DATA_HOME/t3code/hyprland-capture/` (default
`~/.local/share`). A stable executable path avoids AppImage mount paths changing its screen-sharing
permission identity. Discovery checks installed bytes and protocol availability without taking a
screenshot or claiming permission was granted. Helper install/update/remove never edit Hyprland config;
shortcut config edits have a separate read/preview/apply consent flow.
For an unpackaged desktop run, first build it with
`cargo build --locked --release --manifest-path native/hyprland-snap-shot/Cargo.toml`.

The helper reads the active window from the current session's IPC socket. It maps a WLR foreign
toplevel handle to the **full 64-bit address** with `hyprland-toplevel-mapping-v1`, then requests that
object through `hyprland-toplevel-export-v1` v2 with `ignore_damage=1`. It never truncates an address,
guesses a window from a title, or crops a desktop screenshot. Shared-memory buffers are bounded;
stride, channel ordering, premultiplication, and Y inversion are handled before writing a private PNG.
It checks session lock state before and after capture. Closed/changed window metadata is discarded,
so the existing AT-SPI reader never gets the identity of a replacement window.

Activation waits on the IPC event socket for a unique T3 PID/title match and focuses its exact
address. The overlay uses layer-shell surfaces with empty input regions, no keyboard interaction,
and no reserved space. A screenshot texture is clipped/scaled with viewports and subsurfaces across
logical outputs; there is no full-screen CPU repaint per frame and no idle animation loop. Output
changes cancel effects. Short-lived helper processes, private files, and overlays have bounded
lifetimes. `NativeCaptureFeedback.ts` owns the shared KDE/Hyprland stdio lifecycle.

Hyprland's GlobalShortcuts portal registers actions, not key chords. `PortalCaptureShortcut` uses
the stable ID `capture-window` and accepts authenticated activation of the registered action even
when `trigger_description` is empty. `shortcutActionRegistered` is separate from
`shortcutRegistered`: no UI claims the keys are reserved. Other desktops still require an assigned
trigger. The wizard provides a Lua or legacy `.conf` `global` dispatcher binding
for the current desktop application ID. The default example is Ctrl+Shift+2 and does not overwrite
the user's saved GNOME/KDE shortcut. Omarchy's user bindings are preferred over its shipped defaults.

Run `cargo test --locked --manifest-path native/hyprland-snap-shot/Cargo.toml`, plus the focused
Hyprland, portal-shortcut, native-feedback, setup-logic, and artifact-staging tests. Real Hyprland
verification should cover permissions, non-US keyboard layouts, multi-output scaling, cancellation,
focus return, and AT-SPI in a text editor and browser. It is not interchangeable with Plasma tests.

Upstream protocols: [window export](https://github.com/hyprwm/hyprland-protocols/blob/main/protocols/hyprland-toplevel-export-v1.xml),
[window mapping](https://github.com/hyprwm/hyprland-protocols/blob/main/protocols/hyprland-toplevel-mapping-v1.xml).
The official BSD-3-Clause XML and copyright notices ship alongside the helper.

Hyprland 0.56.2 waits while screencopy consent is pending, but can render an access-denied texture
for a rejected request or `no_screen_share` window rule instead of failing the export frame.
The export protocol exposes no separate permission-result field. Do not mistake `ready` for an
explicit permission grant or try another capture API to defeat a denial; do not guess grant state
from image pixels. Accessibility has its own opt-in and app/AT-SPI availability, independent of
the screen-sharing permission. See [ScreenshareFrame](https://github.com/hyprwm/Hyprland/blob/v0.56.2/src/managers/screenshare/ScreenshareFrame.cpp).

## Niri

`NiriSnapShot.ts` speaks newline-delimited JSON directly to the current session's `NIRI_SOCKET`.
It does not shell out to a command or discover sockets belonging to other sessions. Sandboxed
clients do not use this host API. Requests and event waits have five-second deadlines and bounded
messages. A private 0700 temporary directory contains the PNG and is removed on success or failure.

Capture subscribes to `EventStream` and waits for initial window state before requesting
`FocusedWindow`. `ScreenshotWindow` receives that specific window ID and a unique absolute path.
Only `ScreenshotCaptured` for that path completes the operation; unrelated captures and command
acknowledgements do not. The adapter preserves the original PID, app ID, title, and logical window
size only if they still match after capture. A changed/closed window yields image-only context.
Niri does not supply a global screenshot origin, so AT-SPI matching uses logical size and title,
while descendant accessibility coordinates remain untrusted. The root still covers the image.

After the accessibility read starts, activation subscribes to window events, waits for a uniquely
matching T3 title owned by the Electron process, and sends `FocusWindow` by ID. There is no polling
or focus-by-title fallback to another process. Niri does not provide the GNOME extension's flash
or window-flight effects. Niri 26.04's native screenshot action also copies the image to the
clipboard and may show its own screenshot notification; the adapter does not alter clipboard
preferences or patch the compositor.

Niri does not implement the global-shortcut portal. While capture is enabled, `NiriCaptureShortcut.ts`
owns `<desktop-app-id>.SnapShot` on the session bus, exporting the no-argument method
`com.t3tools.SnapShot.Capture` at `/com/t3tools/SnapShot`. Config setup adds a Niri
`binds` entry invoking `gdbus` only after read and diff approval; it does not claim the key is
reserved. This avoids launching or focusing a second Electron instance before capture.
The endpoint respects capture suppression, the existing capture mutex, and the enabled setting;
disabling capture or shutting down releases it. The session bus is the same-user trust boundary.
Development and packaged app IDs use separate endpoints. The ordinary command-palette flow remains
available without configuring a global binding.

## Niri and Hyprland config consent

`CaptureShortcutConfig` runs inside the setup wizard for both desktops. Settings' **Change shortcut**
reopens the shortcut step rather than expanding config controls inline. Opening setup never reads
config contents. **Review changes** approves a read (including Niri includes); the renderer receives
before/after text through trusted desktop IPC and uses the existing Pierre diff viewer. No config
contents cross the server WebSocket or go to a provider. **Save shortcut** sends only a proposal
ID; the desktop keeps the exact proposed bytes, path, and original snapshots. It refuses stale,
replaced, or already-used proposals and checks for edits before writing. Symlinks are preserved by
writing their resolved target, with both paths available under **Advanced**. Writes preserve mode, create a
backup, and rename a staged file atomically. Niri validates the staged config before replacement;
Hyprland reloads after replacement and reports reload/config errors separately from saved bytes.

`captureConfigKdl.ts` reads structure without reformatting KDL; `captureConfigEdit.ts` changes only
capture bindings. Niri conflicts include statically resolved included files. Hyprland checks live
bindings, including dynamic Lua bindings, before preview and apply. Unsupported/dynamic syntax
stays on the manual path rather than guessing. Shortcut selection is always visible in the wizard;
changing it withdraws any previous diff until a new one is reviewed. The config wizard and inline
Settings share `useSnapShotShortcutRecorder`: keycap display, event normalization, capture
suppression, and Escape/blur/unmount cleanup. Config edits serialize Linux Ctrl explicitly rather
than storing the cross-platform `mod` alias. Recording alone never reads or writes a config;
cancelling recording preserves the existing proposal. Primary copy describes the next user action
and keeps read consent explicit. **Advanced** holds file paths, detailed diagnostics, native config-file
selection, manual instructions, and consent-based removal. System/Omarchy defaults are not edit
targets. Existing capture chords are preserved unless a replacement is explicitly requested.

## GNOME extension

Source: `apps/desktop/gnome-extension`. UUID: `snap-shot@t3.codes`.

### Bundled setup

Capture is opt-in. The app shell does not mount a capture onboarding dialog. The Settings toggle
opens a Settings-owned two-step modal wizard: capture access and shortcut configuration.
Its `WizardSteps` indicator is shared with T3 Connect onboarding. Everyday preferences
stay in Settings. One-step shortcut editing records and saves inline without reopening the wizard;
Niri and Hyprland reopen the wizard because changing their keys requires config review and approval.
Setup waits for capture access before enabling registration. When access is already ready, opening
setup restores registration if needed and resumes at the shortcut step. Closing an unfinished
first-time setup disables capture again. Closing setup
for an already enabled feature preserves that state. Installed files and saved choices are kept.
Disabling capture releases the shortcut without uninstalling the extension.

Step guards derive from current desktop state, not a persisted completion flag. GNOME must report
both an enabled extension and an available capture endpoint; a required logout cannot be bypassed.
Returning after login rechecks that state and skips completed access instead of restarting the wizard.
Explicitly selecting the access or shortcut step still allows editing it. Portal requests and Niri
config snippets are not proof of a working shortcut. Setup can finish after saving/requesting a
binding; there is no mandatory test. Settings distinguishes a saved/requested shortcut from an
observed native activation.

Linux artifacts include the files listed in `gnome-extension/bundle.json` at
`resources/gnome-extension`, outside `app.asar`. The desktop builder stages only that allowlist;
tests and packaging metadata are not installed. Development reads the same source directory.

`GnomeCaptureSetup` probes GNOME Shell's Extensions D-Bus interface and the installed metadata.
Installation is an explicit, trusted-main-renderer IPC action. It stages the bundled payload in
the per-user extensions directory, moves any replaced version to
`$XDG_DATA_HOME/t3code/extension-backups`, and renames the completed payload into place. Failed
staging leaves the old install untouched; a failed final rename restores it. No remote extension
API, elevated installer, global user-extension preference, or unrelated UUID is touched.

New local installs require GNOME to discover them on the next login. Setup distinguishes that
state from a discovered-but-disabled extension and exposes Enable/Disable for this UUID only.
Loaded and installed versions are compared so an update cannot be called ready before login.
The setup is available only in a GNOME Wayland host session, not a sandbox or another desktop.

`PortalCaptureShortcut` owns a dedicated D-Bus connection on Wayland outside Niri. It registers
the app identity, creates a session, and always binds the desired shortcut, including on restart.
Electron 44.1.0's restored-session path can skip rebinding and leave callbacks behind on unregister,
so this adapter does not use Electron's global-shortcut API. Native macOS/Windows shortcuts are unchanged.

Binding submission sets `shortcutPending`; only the portal response with an assigned
`trigger_description` sets `shortcutRegistered` and `shortcutLabel`. Settings displays that actual
assignment, including changes reported by `ShortcutsChanged`. Desktop permission controls use
`ConfigureShortcuts` where available (portal v2). Denial is not bypassed by rotating random IDs:
IDs are deterministic per requested chord.
Each session binds only the selected shortcut, allowing Plasma to remove stale bindings. Changing
keys or disabling capture closes the previous session and invalidates its callback. Sound, flash,
and other cosmetic changes keep the existing connection and approval.

Shifted-number shortcuts have a known layout-dependent limitation on Plasma: the recorder stores
the physical digit, while KWin can consume Shift to produce a punctuation keysym. A successful
binding response does not prove that physical chord will activate it. Letter chords work around
this; a general fix needs layout-aware encoding, not a hardcoded US punctuation map.

Signals are checked against the portal's unique owner, current session, and shortcut ID. Method
calls and consent requests are bounded; responses arriving before a method reply are handled.
Portal restarts, denial, and timeout surface as shortcut status instead of a false ready state.
Settings refreshes on the shortcut-change event, focus, or explicit Check again, not continuously.

There is no separate shortcut-test mode or delivery polling. Native activation is observed during
normal capture; manual capture and renderer key events do not verify a shortcut. Verification
is session-local and resets when registration changes. Applying a Niri or Hyprland config diff
is not proof that the compositor delivered a shortcut.

The extension exports `org.gnome.Shell.Extensions.T3SnapShot` at
`/org/gnome/Shell/Extensions/T3SnapShot`. `Version` is a read-only uint32. `Capture()` returns
`(ay png, s metadataJson)`. PNG data stays in memory; no caller-supplied file paths or window IDs
are accepted. `Shell.Screenshot.screenshot_window` snapshots the focused actor synchronously before
asynchronously encoding it. Metadata is read immediately before that call, without yielding.

The caller must own `com.t3tools.T3Code.SnapShot` or
`com.t3tools.T3Code.Development.SnapShot` on the same connection. Names are acquired without
replacement or queueing and checked on each call. This follows GNOME's trusted-session-client
pattern, not authentication against malicious processes with full access to the user's session
bus. Installing/enabling the extension is an explicit trust decision. It refuses locked, greeter,
and non-Wayland sessions; disabling it also prevents in-flight captures from returning pixels.
The extension serializes snapshot requests; it does not wait for the desktop's accessibility read
or attachment persistence. No `unsafe_mode`, Shell evaluation, or global key hooks are used.

Protocol v2 preserves `Capture()` and adds `CaptureWithFeedback(b flash, b animate) -> (ay, s, b)`.
The final boolean says whether Shell created an animation actor. The caller retains the same bus
connection for `Activate(s title)` and `Animate(d x, d y, d width, d height)`. Activation happens
only after capture, once Electron has restored its window if the command-palette action hid it.
`Activate` also records the destination used by `Animate`, so self-capture still calls it.
The bus daemon supplies the caller's PID; only a normal window of that process can be activated.
Title disambiguates multiple windows;
ambiguous matches are rejected. A temporarily hidden window is awaited through Shell's map signal.

Animation coordinates are relative to T3's content area (0–1), including renderer zoom. GNOME
maps them onto the target window's current compositor bounds, avoiding Electron's unavailable
Wayland screen origin. The preview is frozen actor content, not a live clone. Finite Clutter
transitions handle the flash and flight without per-frame JavaScript or polling. Both Electron's
and Shell's reduced-motion preferences are respected. `Animate` replies after landing, and the
desktop waits for that flight before acknowledging/deleting the capture. Disconnecting, disabling,
locking, a monitor change, or a six-second deadline removes Shell actors. The desktop connection
also has a 15-second lifetime bound. Optional focus/effect failures do not discard a captured PNG.

`linuxFeedbackAvailable` is true only for protocol v2. A v1 extension can still capture, but settings
asks for an extension update before offering effects. macOS/Windows keep the existing transition;
the standard portal and picker do not gain GNOME-only focus/overlay capabilities.

The extension targets GNOME Shell 45–50's ES module API. GNOME Shell internals are not stable across
major versions: review the capture API and verify each future version before adding it to metadata.
GNOME 50 removed the X11 compositor and `Meta.is_wayland_compositor`; the compatibility check calls
that function only on older versions where it exists.

### Package and install for testing

```bash
vp run dist:gnome-extension
gnome-extensions install --force release/snap-shot@t3.codes.shell-extension.zip
```

Sign out and back in if this is the first install, then:

```bash
gnome-extensions enable snap-shot@t3.codes
```

Wayland does not support restarting Shell with Alt+F2 → `r`. Do not restart someone's live session
to test an extension. After changing extension source, repack/reinstall and sign out/in to ensure
the new module is loaded. Reopening/focusing T3's capture settings refreshes capability discovery.

To revoke/uninstall:

```bash
gnome-extensions disable snap-shot@t3.codes
gnome-extensions uninstall snap-shot@t3.codes
```

### Verification

```bash
vp test run apps/desktop/src/snapShot/LinuxSnapShot.test.ts apps/desktop/src/snapShot/LinuxSnapShot.dbus.test.ts apps/desktop/src/snapShot/DesktopSnapShot.test.ts apps/desktop/gnome-extension/captureService.test.js apps/web/src/components/settings/SnapShotSettings.logic.test.ts
```

The D-Bus test uses its own daemon/socket in a temporary directory, not the desktop session bus.
It runs when `dbus-daemon` is available. Unit tests cover capability selection, early responses,
timeouts, cancellation, fallback boundaries, image validation, extension authorization/lifecycle,
X11 rejection, and backend-specific status text. They do not prove a live GNOME Shell capture.

For a live pass, explicitly enable the extension and approve T3's shortcut. Capture a known native
Wayland app and an XWayland app using both the shortcut and command palette. Check the PNG, window
identity, and optional text; test mixed-DPI displays. Disable the extension and confirm fallback.
Test a v3-capable portal separately: this host's GNOME Screenshot v2 cannot validate that backend.

Protocol references: [Screenshot portal](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.Screenshot.html),
[Request lifecycle](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.Request.html),
[host Registry](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.host.portal.Registry.html),
[GNOME screenshot implementation](https://gitlab.gnome.org/GNOME/gnome-shell/-/blob/main/src/shell-screenshot.c).
