---
title: "SnapShots"
description: "Capture a window into your T3 Code draft with SnapShots, configure its shortcut, and choose whether to include app accessibility text."
updated: 2026-11-04
sources:
  - label: "SnapShots setup, permissions, and Linux desktops"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/snap-shot.md"
faq:
  - question: "What is a SnapShot in T3 Code?"
    answer: "A T3 Code SnapShot captures your current window and attaches it to your draft. It includes the app name, window title, and available app icon and accessibility data."
  - question: "What is the default T3 Code SnapShot shortcut?"
    answer: "On macOS and Windows, the default T3 Code SnapShot shortcut is both Shift keys together. Linux uses a key chord rather than a modifier pair."
  - question: "Does T3 Code SnapShots work on Linux?"
    answer: "T3 Code SnapShots supports Linux Wayland sessions, including apps running through XWayland. X11 sessions are not supported, and setup depends on the desktop."
  - question: "Can I capture a screenshot without app text in T3 Code?"
    answer: "Turn off Include app text in T3 Code SnapShots settings to attach only the screenshot. On macOS, this also removes the Accessibility permission requirement."
---

T3 Code SnapShots captures the window you are working in and attaches it to your current draft. It can include the app name, window title, app icon, and accessibility data so an agent can reason about the screenshot and its controls.

## Enable window capture on your desktop

SnapShots is off by default. It is available in the desktop app on macOS, Windows, and Linux Wayland. X11 sessions are unsupported.

1. Open `Settings → SnapShots`.
2. Turn the feature on.
3. Complete the capture-access step for your desktop.
4. Choose the shortcut.

Setup shows the steps your desktop needs. On macOS, capture requires Screen Recording permission. Accessibility permission is requested only when `Include app text` is enabled. Windows requires no setup permission.

Choose `Finish later` if you need to interrupt setup. This turns capture off while keeping installed components so you can resume. Turning capture off later releases the shortcut, but does not uninstall helpers or extensions.

## Attach the window you want to discuss

1. Switch to the window containing the problem or reference.
2. Press the capture shortcut.
3. Inspect the attachment in the T3 Code draft.
4. Add a message explaining what the agent should investigate.

On macOS and Windows, the default shortcut is both Shift keys together. T3 Code brings itself forward with the capture attached. If no thread is open, it starts a draft in the current project. Pressing the shortcut while T3 Code is in front captures T3 Code itself.

Name the issue in the message. For example, identify the clipped control or the text that differs from your expectation. The capture provides context; your message states the task. See [messages and context](/learn/threads/messages-and-context) for the broader attachment workflow.

Pending captures remain on disk until saved to the draft. If the app closes during that interval, the capture is attached on the next launch. Images rejected for excessive size are discarded.

## Decide whether to include app text

| Capture mode             | When to choose it                                                       |
| ------------------------ | ----------------------------------------------------------------------- |
| Screenshot with app text | You want available controls, text, and positions to accompany the image |
| Screenshot only          | You want the image without accessibility data                           |

`Include app text` controls accessibility data. Availability depends on the captured app. Some apps expose window controls without exposing document or terminal contents. If an app responds slowly, T3 Code attaches the screenshot without waiting for its data.

Inspect the icon beside the app name on the attachment to see whether accessibility data was included. Select it to inspect that data. Missing text does not mean the screenshot failed.

On GNOME, browsers may need app accessibility enabled in desktop accessibility settings. Restart the browser after enabling it. Review the attachment before sending when the window contains information outside your task. The [security and privacy guide](/learn/safety/security-and-privacy) covers the wider agent-data context.

## Change shortcuts and capture feedback

Select the shortcut in Settings, press the new keys, then choose `Save`. macOS and Windows accept modifier pairs or key chords. T3 Code rejects shortcuts reserved by the operating system or conflicting with its own keybindings.

Linux requires a key chord. On Niri and Hyprland, `Change shortcut` reopens setup because the binding lives in compositor configuration. Capture sound, window flash, and attachment animation each have independent settings. Reduced motion also disables the animation.

## Complete Linux desktop setup

| Desktop                | Setup requirement or useful check                                            |
| ---------------------- | ---------------------------------------------------------------------------- |
| GNOME                  | Install the bundled extension, sign out and back in, then enable it          |
| KDE Plasma 6           | Install the helper; check system keyboard shortcuts if capture does not fire |
| Hyprland and Omarchy   | Install the helper and review the proposed compositor binding                |
| Niri                   | Review and save the validated binding; it requires `gdbus`                   |
| Other Wayland desktops | Use portal capture where supported, or the window picker in manual mode      |

On Omarchy, put bindings in your own configuration. T3 Code backs up the Hyprland configuration change and reloads it. If capture returns an access-denied image, inspect the helper's screen-sharing permission.

Niri setup also keeps a backup before saving. Portal picker captures do not include accessibility data. These differences explain why the same capture preference can require separate setup after changing Linux desktops.

## Next steps

- Ask for an [annotated visual reply](/learn/workspace/visual-replies) to explain the captured problem.
- Use [browser import](/learn/workspace/browser-import) or [default-browser routing](/learn/workspace/default-browser) when you need the web page itself.
- Return to the [workspace guides](/learn/workspace) to choose your next inspection step.
