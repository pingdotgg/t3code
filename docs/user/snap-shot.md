# SnapShots

SnapShots are available in the desktop app on macOS, Windows, and Linux with Wayland. It captures a window
from any app and adds the image to the current draft. The attachment includes the app name, window
title, and, when available, the app icon and accessibility data. That data can identify controls,
text, their hierarchy, and their locations in the screenshot. It can include content outside the
visible scroll area when the app exposes it.

SnapShots are off by default. There is no startup popup. Open **Settings** > **SnapShots**
and turn it on to open a two-step setup dialog: allow capture, then choose a shortcut.
Each step shows only what your desktop needs. **Finish later** pauses first-time setup and turns
capture back off; installed extension files and saved choices remain for your next attempt.
After setup, Settings keeps the everyday capture preferences. Select **Manage capture** to check
access again, or the setup button for your current desktop if something is missing. Setup resumes at the first unfinished
step: a running GNOME extension skips installation and goes straight to the shortcut step.
To change your shortcut afterward, select it directly in Settings, press the new keys, then select
**Save**. On Niri and Hyprland, **Change shortcut** reopens setup so you can review the changes before
saving. **Cancel** keeps your saved shortcut. Your desktop may ask you to approve a new shortcut.
Turning capture off unregisters the
shortcut; it does not uninstall an extension or capture helper you installed.

When you switch between GNOME, KDE Plasma, Niri, and Hyprland, your capture preferences stay the same.
Setup names your current desktop and checks its capture access and shortcut separately. You may
need to install that desktop's helper or approve its shortcut. Your other desktops' extensions and
bindings stay in place, so switching back does not require starting over. Shortcut permissions
belong to each desktop; approval on GNOME does not grant access on Plasma or Niri.

Press both Shift keys together to capture a
window on macOS or Windows. Select the shortcut in Settings to record a different
binding: press both keys of another modifier such as Command, Ctrl, or Alt together, or press a key
chord. On Windows and Linux, the Windows or Super key can also open the system's own menu, so prefer
another modifier there. T3 Code checks its own keybindings and, outside Wayland sessions, asks the
operating system whether the shortcut is already reserved before it lets you save.

On Linux with Wayland, choose a key chord; modifier-pair shortcuts are not supported. On Niri and
Hyprland, configure the shortcut in the desktop's config as described below. On other desktops, saving submits
the shortcut to your desktop's global-shortcut portal. Approve the system prompt if one appears.
Settings shows when permission is pending or denied, then displays the shortcut your desktop
actually assigned. Your desktop may reuse a previous approval without showing another prompt.
When available, **Shortcut permissions** opens your desktop's controls to approve or change a
shortcut. If your desktop cannot open those controls from T3 Code, use its shortcut settings instead.
There is no separate test step: use the assigned shortcut from another app to capture its window.
Changing the shortcut replaces the active binding without restarting T3 Code.

With automatic capture, the shortcut captures the active window, including T3 Code itself,
without hiding that window. Repeated shortcut presses within 200 ms are ignored to prevent
accidental duplicate captures.
You can also use **Take snapshot** from the command palette, including when your desktop does
not support global shortcuts. That action briefly hides T3 Code to capture the app behind it,
then returns to your draft.

## Platform behavior

- On macOS, T3 Code asks for Screen Recording when you select **Allow capture** during setup
  and the permission is not already granted. It asks for Accessibility only when **Include app text**
  is enabled. Modifier-pair shortcuts need no additional permission on macOS.
- On Windows, no setup or permission is needed. Turn SnapShots on and the shortcut captures the active window.
- On Niri 25.11 or newer, T3 Code captures the active window through Niri directly, without an
  extension or picker. It uses the captured window's identity for available accessibility data
  and brings T3 Code forward afterwards.
- On KDE Plasma 6, install the bundled capture helper during setup to capture the active window
  without a picker. T3 Code uses matching window metadata for available accessibility data and
  attempts to bring your draft forward after capture.
- On Hyprland, including Omarchy, install the bundled helper to capture the active window without
  a picker, include matching accessibility data when available, and animate the image into your draft.
- On Linux with Wayland, T3 Code uses your desktop's Screenshot portal when it supports version 3
  and advertises active-window capture. Your desktop may still ask for permission.
- On GNOME, the optional **T3 Code SnapShots** extension enables active-window capture when
  the portal does not support it. The extension supplies the app and window identity, allowing
  T3 Code to attempt an accessibility lookup. Data is included only when the window matches.
  The current extension also brings T3 Code to the foreground after capture and supports the
  capture flash and attachment animation.
- Without an automatic path, Settings shows **Manual capture only** and setup explains that your
  shortcut opens a picker. Choose a window or screen each time. Standard portal and picker captures
  do not include accessibility data or verified app identity; the accessibility option is unavailable
  for those methods. An unsupported GNOME extension version still allows this manual flow.
- X11 sessions do not support snapshots. Apps running through XWayland inside a Wayland
  session can still be captured by the compositor.

Both the shortcut and command-palette action use the same platform capture method. Cancelling or
denying a capture does not retry through a different backend. Settings shows which Linux backend is
available; shortcut approval is separate from capture permission.

### KDE Plasma

Open **Settings** > **SnapShots** in your Plasma Wayland session and turn it on:

1. Select **Install helper**. The helper is bundled with T3 Code; nothing is downloaded and you
   don't need to sign out. It allows KDE to recognize T3 Code's capture requests even with an AppImage.
2. Wait for **Capture is ready**, then choose a shortcut such as **Ctrl+Shift+2**. Save it and
   approve the desktop prompt if one appears.
3. Select **Done** (or **Save and finish** for a changed shortcut). Press the shortcut from another
   app to capture the window you're using.

If access fails, use **Check again** or **Reinstall helper**. If the shortcut doesn't arrive, check
T3 Code under **System Settings** > **Keyboard** > **Shortcuts**. You can still
capture from the command palette when global shortcuts are unavailable.
If a shortcut using Shift and a number doesn't fire on your keyboard layout, try a letter chord
such as **Ctrl+Alt+Y** instead.

Reopen **Manage capture**, select **Access**, expand **Advanced**, and choose **Remove capture helper** to revoke this
integration. Only T3 Code's capture helper and its registration are removed. A newer bundled helper
is installed only when you select **Update helper**. Turning capture off stops the shortcut but keeps
the helper installed. The current helper also provides window flash and flight animations; control
them with **Capture flash** and **Capture animations**. No separate desktop effect download is needed.

### Hyprland and Omarchy

Open **Settings** > **SnapShots** inside Hyprland and turn capture on:

1. Select **Install helper**. It is bundled with T3 Code; no download, administrator password,
   plugin, or sign-out is needed.
2. Continue to **Shortcut**, click the shortcut, and press your desired keys. Select **Review changes**
   to let T3 Code read your desktop settings and show the proposed changes here in the app.
3. Review the changes and select **Save shortcut**. T3 Code saves just those changes, keeps a
   backup, and reloads Hyprland. The default shortcut is **Ctrl+Shift+2**; existing capture keys
   are preserved unless you choose different ones.
4. Use the shortcut from another app. If Hyprland asks for screen-sharing
   permission for T3 Code's capture helper, approve it, then retry capture if necessary.

Hyprland manages the actual keys. There is no shortcut permission popup, and T3 Code registering
its capture action does not prove the key binding is configured. **Change shortcut** offers the
shortcut step in the setup wizard, where you can choose new keys and review the config diff.
Expand **Advanced** to select a custom config, copy a binding for manual setup, or review
shortcut removal. Lua and older `.conf` configs are supported. On Omarchy, use your own bindings,
not its shipped defaults. If the file changes while the diff is open, T3 Code asks you to review it
again instead of overwriting your edits.

The shortcut needs `xdg-desktop-portal-hyprland` running in the session. If setup cannot connect,
check that service and restart T3 Code. Capture itself uses Hyprland's native window-export and
window-mapping protocols. Setup reports when the compositor needs updating; it does not fall back
to a whole-screen screenshot. Keep Hyprland's permission controls enabled. If capture is denied,
review its screen-sharing permissions instead of disabling permission enforcement.
Some Hyprland versions return an access-denied image instead of an error when capture is blocked.
That image is not a successful capture of the app; review the helper's permission and try again.

**Capture flash** and **Capture animations** control the optional overlay. Accessibility text
uses the same app-dependent accessibility APIs as GNOME and Plasma; an app that exposes no text
still produces an image-only capture. Turning capture off unregisters T3 Code's action. Remove
the config binding to release the keys. **Manage capture** > **Access** > **Advanced** > **Remove capture helper**
removes only T3 Code's installed helper.

### Niri

Run T3 Code inside your Niri session, then enable SnapShots. On the shortcut step:

1. Click the shortcut and press your desired keys, then select **Review changes** to let T3 Code read
   your desktop settings. The changes appear here in the app; no editor opens.
2. Review the changes, then select **Save shortcut**. T3 Code validates the proposed Niri config,
   saves the approved change, and keeps a backup. Niri reloads it automatically.

The default is **Ctrl+Shift+2**. Existing capture keys are kept unless you choose different ones.
**Change shortcut** in Settings reopens the wizard at the shortcut step to choose keys and
review the config change. Expand **Advanced** for custom config selection, manual copy/paste,
file paths, troubleshooting details, backup location, or shortcut removal.
The default config is `~/.config/niri/config.kdl`; `NIRI_CONFIG` and `XDG_CONFIG_HOME` are respected.
If you started Niri with `--config` or switched config files, choose that file in **Advanced**.
The binding requires `gdbus`, normally provided by your distribution's GLib tools package.

Niri activates this shortcut through its config; the recorder only chooses the keys. There is no portal approval prompt,
and saving a binding does not confirm delivery. Use your shortcut from another app. If it fails, check Niri's config errors with
`niri validate` and make sure `gdbus` is installed.
The shortcut works while T3 Code is running
with capture enabled. Disable capture in T3 Code to stop accepting it; remove the line from your
Niri config to release the key. The command-palette action also works without this setup.

Niri 26.04 also copies the captured image to the clipboard and may display a screenshot notification.
Its capture path does not provide the GNOME window flash or flight animation. Accessibility text
and structure may be included, but individual control coordinates are omitted when they cannot be
mapped reliably to the screenshot.

### GNOME extension

Open **Settings** > **SnapShots** in your GNOME Wayland session and turn it on to start setup:

1. In the capture-access step, select **Install extension**. The extension ships with the Linux app; installation is
   offline, per-user, and does not require an administrator password. It supports GNOME Shell 45–50.
2. If setup says to sign out, save your work and sign out of GNOME, then sign back in. Restarting
   T3 Code alone does not make GNOME discover a newly installed extension.
3. Return to SnapShots and reopen setup. If the extension is already running, setup skips
   straight to your shortcut. Otherwise select **Enable extension**. Use **Check again** to refresh its
   status. The button shows **Checking…**, then setup confirms the result, even when it is unchanged.
   If GNOME has disabled all user extensions, turn them on in GNOME's Extensions app first;
   T3 Code will not change that global preference or enable unrelated extensions.
4. Continue to the shortcut step. Record a key chord, select **Save and finish**, and approve
   GNOME's shortcut prompt. You can then capture from another app with that shortcut. Extension
   access and shortcut permission are separate.

Setup distinguishes missing, disabled, running, outdated, incompatible, and failed extensions.
Bundled updates are explicit and may also require signing out. Replaced extension files are kept
in your user data directory under `t3code/extension-backups` for recovery.

Enabling this extension grants T3 Code access to the focused window without a per-capture picker.
It captures the rendered window, not an entire scrollable document. It does not work while the
session is locked. Select **Disable extension** under **Advanced** in the first setup step, or disable it in GNOME's Extensions app,
to revoke this access; T3 Code
will return to the portal or picker path. Remove it there to uninstall it.

Accessibility-data availability depends on the captured app and the operating system. T3 Code still
attaches the image when an app does not expose accessibility data. It waits up to three seconds for
the data; if the app responds too slowly, the screenshot is attached without it. You can capture
another window while that lookup finishes. Finishing an earlier capture does not bring T3 Code
forward again. When a complete element tree is unavailable but text was read in time, T3 Code
includes that text as a fallback.
Turn off **Include app text** in SnapShots settings to skip the accessibility lookup
and attach screenshots without text or UI structure. On macOS, this also removes the Accessibility
permission requirement for snapshots; Screen Recording permission is still required.

On GNOME, browsers may need desktop app accessibility enabled before they expose text. This is
separate from the speaking screen reader and from screenshot permission. Restart the browser after
enabling app accessibility. Some apps expose only window controls, not the document or terminal
contents; an accessibility indicator does not guarantee that all visible content was included.

A small icon beside the app name on a capture attachment indicates what is included: text lines
mean accessibility data accompanies the screenshot; an image icon means screenshot only. Select
the icon to inspect the capture. Structured element trees appear as formatted JSON, including roles,
hierarchy, states, actions, and any trustworthy image-coordinate bounds. Captures that provide only
flat or legacy accessibility text show that text instead. The same icon appears beside the file name
in the expanded screenshot preview. T3 Code sends agents a compact copy that removes unavailable or
redundant structural fields while preserving meaningful accessibility content; the inspected JSON
remains the complete captured tree.

After capture, T3 Code brings your draft forward with the image attached. If no thread is open,
it starts a draft in the current project.

## Feedback

The settings page controls the capture sound, gentle window cue, and attachment animation
separately. Choose **Off**, **Whoosh** (the default), or **Click** for the capture sound. Use the
play button beside the sound selector to preview it. With animations on, a frozen image of the
captured window flies into its new composer attachment and settles into place; the real window stays
in place. Turn off animations to remove capture motion.
The operating system's reduced-motion setting also disables the attachment animation.
On Linux, the full window-to-composer effect uses the current T3 Code GNOME extension or KDE/Hyprland
capture helper. Niri, portal, and picker capture use a short composer arrival effect instead.
After updating an older GNOME extension, sign out and back in to load the new version. KDE helper
updates do not require signing out. Settings tells you when an update is needed.

Pending captures stay on disk until the image is saved in the draft. If T3 Code closes during that
step, it retries the capture the next time the desktop app starts. Captures rejected because the
image is too large are deleted and cannot be retried.
