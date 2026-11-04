---
title: "Remote and mobile"
description: "Use T3 Code from another computer or your phone, choose a remote connection, watch mobile devices, and share agent work with a guest."
updated: 2026-11-04
sources:
  - label: "Remote access"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/remote-access.md"
  - label: "Devices"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/devices.md"
  - label: "Mobile notifications"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/mobile-notifications.md"
  - label: "Guest links"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/guest-links.md"
  - label: "Background service"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/background-service.md"
  - label: "Theo Browne on remote reliability, 8:02"
    url: "https://www.youtube.com/watch?v=xJaMTo2YgO8&t=482s"
faq:
  - question: "Can I use T3 Code away from my computer?"
    answer: "T3 Code connects your phone, browser, or desktop client to a server running on another machine. That host must remain awake, running, and reachable."
  - question: "Do T3 Code agents run on my phone?"
    answer: "T3 Code's mobile app controls agents running on your connected machines. The host owns the projects, provider credentials, and execution."
  - question: "Do I need T3 Connect for remote access?"
    answer: "T3 Code also supports direct network pairing, Tailscale HTTPS, and desktop-managed SSH. Background mobile notifications and guest links require T3 Connect."
---

T3 Code lets you follow and steer coding agents on your machines from a phone, browser, or another desktop. Connect through T3 Connect, a reachable network address, Tailscale HTTPS, or desktop-managed SSH. Work runs on the host, which must remain awake and reachable.

## Choose how to reach your machine

Start with [remote access](/learn/remote/remote-access) to choose a connection and pair your client. T3 Connect provides an address for your environment without router forwarding. Direct pairing suits a local or private network. Tailscale HTTPS gives devices on your tailnet a secure endpoint. Desktop-managed SSH launches or reuses a server on a supported remote host.

These routes reach the same environment. Switching routes does not move its projects or threads to the device in your hand. A machine can keep several routes, and T3 Code tries them in their saved order.

Theo Browne describes his preference in the [8:02 transcript segment](https://www.youtube.com/watch?v=xJaMTo2YgO8&t=482s): “I find T3 Code to be much more pleasant, much more stable, much more reliable, especially with remote stuff.” That is his experience. Choose your connection based on the network and machines you use.

## Follow work from iPhone or Android

Install the [T3 Code mobile apps](/learn/remote/mobile-apps), then connect to the machine that runs your work. T3 Connect account discovery and direct pairing are separate ways to add an environment. A saved connection lets you return to its threads from your phone.

Enable [mobile notifications](/learn/remote/mobile-notifications) when you want alerts about completed work, failures, approvals, or questions. Push delivery needs T3 Connect and activity publishing on the environment. A working direct connection alone does not set up those alerts.

## Watch agents test mobile apps

The [Device panel](/learn/remote/devices) shows iOS simulators and Android emulators alongside a thread. You and an authorized agent can interact with the same device. Devices run on the environment's machine or a configured device host, so check its platform dependencies before starting.

## Invite someone to follow one thread

Use [guest links](/learn/remote/guest-links) when someone needs to watch a thread and propose questions without an account. You review each proposed message before it runs. Guest access lasts for one browser and expires after 24 hours.

## Keep the host available

On Linux and macOS, a [background service](/learn/safety/background-service) can keep T3 Code running without an open terminal. Windows hosts need the desktop app or a foreground server to stay running. When a connection fails, [T3 Connect troubleshooting](/learn/remote/t3-connect-troubleshooting) separates client network, account, tunnel, and host failures.

## Next steps

- [Set up remote access](/learn/remote/remote-access) for the machine that owns your projects.
- [Install the mobile app](/learn/remote/mobile-apps) to continue from your phone.
- [Browse the full library](/learn) for agent setup and thread workflows.
