# SnapShots

A SnapShot captures the window you are working in and attaches it to your current draft. The
attachment carries the app name and window title, and when available the app icon and the window's
accessibility data (its controls, text, and their positions in the image). Agents can use that data
to reason about the screenshot.

SnapShots are off by default and available in the desktop app on macOS, Windows, and Linux with
Wayland. X11 sessions are not supported.

## Turning it on

Open **Settings** > **SnapShots** and turn the feature on. Setup has two steps: allow capture, then
choose a shortcut. Each step shows only what your desktop needs. **Finish later** turns capture back
off but keeps anything you already installed, so you can resume where you left off.

- **macOS** asks for Screen Recording during setup. It asks for Accessibility only when **Include
  app text** is on.
- **Windows** needs no setup or permission.
- **Linux** depends on your desktop. See [Linux desktops](#linux-desktops).

Turning capture off releases the shortcut. It does not uninstall a helper or extension you installed.

## Taking a capture

Switch to the window you want and press the shortcut. The default on macOS and Windows is both
Shift keys together. T3 Code attaches the image to your draft and brings itself forward. If no thread
is open it starts a draft in the current project.

Pressing the shortcut while T3 Code is in front captures T3 Code itself.

Pending captures are kept on disk until the attachment is saved to the draft, so a capture survives
closing the app mid-way and is attached on the next launch. Captures rejected because the image is
too large are discarded.

## Changing the shortcut

Select the shortcut in Settings, press the new keys, then **Save**. On macOS and Windows you can use
a modifier pair such as Command+Command or Ctrl+Ctrl, or a key chord. T3 Code refuses shortcuts
that collide with its own keybindings or that the operating system already reserves.

On Linux, choose a key chord; modifier pairs are not supported. On Niri and Hyprland the shortcut
lives in your compositor config, so **Change shortcut** reopens setup to review the change.

## Include app text

**Include app text** controls whether captures include the window's accessibility data. Turn it off
to attach screenshots only. On macOS this also drops the Accessibility permission requirement.

Availability depends on the app. Some apps expose only their window controls, not the document or
terminal contents. If an app is slow to answer, T3 Code attaches the screenshot without the data
rather than waiting.

On GNOME, browsers may need app accessibility enabled in the desktop's accessibility settings before
they expose text. Restart the browser after enabling it.

An icon beside the app name on an attachment shows whether accessibility data was included. Select
it to inspect what was captured.

## Sound, flash, and animation

Settings controls the capture sound, the brief flash on the captured window, and the animation that
flies the image into your draft. Each can be turned off independently. The operating system's
reduced-motion setting also disables the animation.

## Linux desktops

SnapShots work on Wayland sessions. Each desktop provides capture differently, and setup names your
current desktop and shows only what it needs. Preferences carry across desktops, but each desktop's
helper and shortcut approval are separate.

**GNOME.** Install the bundled **T3 Code SnapShots** extension during setup. It is installed
per-user, offline, and needs no administrator password. Sign out and back in after the first
install so GNOME discovers it, then enable it from setup or from GNOME's Extensions app. If GNOME
has disabled all user extensions, turn them on there first. Disable or remove the extension in
GNOME's Extensions app to revoke access.

**KDE Plasma 6.** Install the bundled capture helper during setup; no sign-out is needed. If the
shortcut does not fire, check T3 Code under **System Settings** > **Keyboard** > **Shortcuts**. If a
shortcut using Shift and a number does not work on your keyboard layout, use a letter chord instead.
Remove the helper from **Manage capture** > **Access** > **Advanced**.

**Hyprland and Omarchy.** Install the bundled helper during setup, then choose a shortcut and select
**Review changes**. T3 Code shows the exact change it will make to your Hyprland config. **Save
shortcut** writes only that change, keeps a backup, and reloads Hyprland. Approve the screen-sharing
prompt for the helper if one appears. On Omarchy, bind in your own config, not the shipped defaults.
Some Hyprland versions return an "access denied" image instead of an error when capture is blocked;
check the helper's screen-sharing permission.

**Niri.** Choose a shortcut and select **Review changes**. T3 Code shows the exact binding it will
add to your Niri config, validates the result, keeps a backup, and saves it when you approve. Niri
reloads the config on its own. The binding needs the `gdbus` command, normally part of your
distribution's GLib tools. Remove the line from your config to release the key.

**Other Wayland desktops.** T3 Code uses the desktop's screenshot portal when it can capture the
active window. Otherwise Settings shows **Manual capture only** and the shortcut opens the desktop's
window picker. Picker captures do not include accessibility data.

Apps running through XWayland inside a Wayland session can still be captured.
