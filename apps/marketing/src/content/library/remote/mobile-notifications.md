---
title: "Mobile notifications"
description: "Set up T3 Code mobile notifications for agent results, approvals, and questions, then check iOS Live Activities and Android ongoing updates."
updated: 2026-11-04
sources:
  - label: "Mobile notifications and platform requirements"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/mobile-notifications.md"
  - label: "Remote access and T3 Connect"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/remote-access.md"
  - label: "Keeping a host running"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/background-service.md"
faq:
  - question: "How do I enable T3 Code mobile notifications?"
    answer: "Sign in to T3 Connect, link the environments, and enable Device Notifications in T3 Code's Settings → Notifications. The environment also needs agent activity publishing enabled."
  - question: "Does T3 Code send notifications over Tailscale?"
    answer: "A direct or Tailscale connection alone does not enable T3 Code background push notifications. Background delivery requires T3 Connect."
  - question: "Does T3 Code support iOS Live Activities?"
    answer: "Enable Live Activity Updates in T3 Code's notification settings on iOS. Finished results can remain visible for up to 15 minutes."
  - question: "Why are T3 Code notifications silent while I use the app?"
    answer: "T3 Code keeps ordinary alerts quiet while the mobile app is in the foreground. Ongoing activity continues updating, and viewing the thread on another device does not silence the phone."
---

T3 Code sends mobile alerts when an agent finishes, fails, needs approval, or asks for input. Sign in to T3 Connect, link your environments, and enable `Device Notifications` in `Settings → Notifications`. Each environment must also have agent activity publishing enabled.

## Set up alerts after connecting your host

Start with a working host connection in the [mobile app](/learn/remote/mobile-apps). Notifications add a way to return when something needs your attention. They do not start the host or repair an unavailable machine.

1. Sign in to T3 Connect on your phone.
2. Link the environments whose agent activity you want to follow.
3. Enable agent activity publishing on those environments.
4. Open `Settings → Notifications` in the mobile app.
5. Enable `Device Notifications` and check system notification permissions.

When an alert arrives, tap it to open the relevant thread. This gives you a direct route back to the work that completed or needs a response. You do not have to keep the mobile app connected continuously to receive background push delivery.

A direct LAN or Tailscale connection can make a thread usable without enabling push. If you can read and steer an agent but receive no background alerts, confirm T3 Connect setup separately. The [remote access guide](/learn/remote/remote-access) explains the distinction between a network route and an account-linked connection.

## Choose an ongoing activity display

Ordinary alerts tell you that an event occurred. Ongoing activity follows work without requiring you to reopen the app. Use the switch that matches your platform:

| Platform               | T3 Code setting          | What to expect                                                  |
| ---------------------- | ------------------------ | --------------------------------------------------------------- |
| iOS                    | `Live Activity Updates`  | Live Activity updates while work runs                           |
| Android 16 and newer   | `Agent Live Updates`     | A Live Update when system settings and device support permit it |
| Older Android versions | `Ongoing Agent Activity` | A regular ongoing activity notification                         |

Finished results remain visible for up to 15 minutes. An activity card can therefore remain after an agent has stopped. That remaining card does not mean another turn is running.

On Android, dismissing an activity card does not disable alerts. Turn off the corresponding ongoing-activity switch to stop future cards. Choose the switch based on whether you want continuing activity display, rather than dismissing each card as it appears.

## Understand when alerts stay quiet

T3 Code keeps ordinary alerts quiet while the mobile app is in the foreground. Ongoing activity continues to update during that time. Check background behavior before treating a quiet foreground session as a delivery failure.

Opening the same thread on another device does not silence your phone's alerts. For example, watching work on a desktop does not suppress its mobile notifications. Manage notification permission or channels through your phone's system Settings when you want to change system-level behavior.

## Check Android notification support

Android notifications require Android 7.0 or newer and Google Play services. Device support and system settings determine whether Android 16 and newer promote ongoing activity to a Live Update. Other devices show a regular ongoing notification.

If an Android 16 device shows no promoted update, open `Live Update Settings` in T3 Code's `Settings → Notifications`. Check that setting alongside system notification permission and Android notification channels. A regular activity notification and a promoted Live Update are different presentations.

Force-stopping the Android app from system Settings prevents push delivery until you open it again. Reopen the app before testing delivery after a force stop. Android 7 battery-saving modes can also delay removal of expired activity cards, so an old card alone does not show current agent activity.

## Diagnose missing alerts in a useful order

| What you observe                                                          | Check next                                                       |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Threads work through LAN or Tailscale, but background alerts never arrive | T3 Connect sign-in, linked environments, and activity publishing |
| Alerts stay quiet while you read the mobile app                           | Foreground behavior, then test with the app in the background    |
| Android push stopped after using Force stop                               | Open the app again                                               |
| Ongoing Android activity appears without promotion                        | Device support, system settings, and `Live Update Settings`      |
| An expired card remains on Android 7                                      | Battery-saving behavior affecting card removal                   |

If the host itself is unavailable, start with [T3 Connect troubleshooting](/learn/remote/t3-connect-troubleshooting). A notification preference cannot make an offline host answer. On Linux and macOS, a [background service](/learn/safety/background-service) keeps the server available without an open terminal. Windows requires the desktop app or foreground server to remain running.

## Next steps

- Return to [remote and mobile](/learn/remote) for the full setup sequence.
- Use the [mobile app guide](/learn/remote/mobile-apps) to check pairing and saved environments.
- Open the thread's [device viewer](/learn/remote/devices) when you need to inspect an agent's mobile testing.
