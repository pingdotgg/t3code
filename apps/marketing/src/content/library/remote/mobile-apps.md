---
title: "T3 Code on iPhone and Android"
description: "Install the T3 Code iPhone or Android app, pair it with your machines, and follow or steer coding agents while work runs on the host."
updated: 2026-11-04
sources:
  - label: "Official mobile store URLs"
    url: "https://github.com/pingdotgg/t3code/blob/main/apps/marketing/src/lib/site.ts"
  - label: "Mobile app variants"
    url: "https://github.com/pingdotgg/t3code/blob/main/apps/mobile/README.md"
  - label: "Remote access and pairing"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/remote-access.md"
  - label: "Mobile notifications"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/mobile-notifications.md"
  - label: "Watch devices from mobile"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/devices.md"
  - label: "Guest message review"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/guest-links.md"
  - label: "Connection recovery"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/internals/connection-runtime.md"
faq:
  - question: "Is there a T3 Code iPhone app?"
    answer: "T3 Code has an official iPhone and iPad app on the App Store. It connects to your machines so you can control agent work remotely."
  - question: "Is T3 Code available on Android?"
    answer: "T3 Code has an official Android app on Google Play. Add a host through T3 Connect or pair with a network address your phone can reach."
  - question: "Does the T3 Code mobile app run agents on my phone?"
    answer: "T3 Code mobile follows and steers agents running on connected host environments. The host retains the project files, provider credentials, and execution."
  - question: "Can I pair T3 Code mobile without T3 Connect?"
    answer: "T3 Code supports direct pairing when your phone can reach the host over a LAN or private network. Background push notifications still require T3 Connect."
---

T3 Code has official iPhone, iPad, and Android apps for following and steering coding agents on your machines. Install the app, then connect through T3 Connect or a reachable host address. The agents run on the host, so that machine must stay awake and running while you use your phone.

## Install the official iPhone or Android app

Use the store links published by the official T3 Code site:

| Device         | Official download                                                                                 |
| -------------- | ------------------------------------------------------------------------------------------------- |
| iPhone or iPad | [T3 Code on the App Store](https://apps.apple.com/us/app/t3-code-remote-claude-more/id6787819824) |
| Android        | [T3 Code on Google Play](https://play.google.com/store/apps/details?id=com.t3tools.t3code)        |

The [download page](/download) also links to both stores. The released mobile app is named `T3 Code`. The repository's `T3 Code Dev` and `T3 Code Preview` variants serve development and internal preview workflows. You do not need to build a native client to install the store release.

Install T3 Code on the machine that will host your projects as well. Your phone connects to that environment; installing the phone app does not create a running host.

## Add your machine through T3 Connect

T3 Connect provides account-based access without configuring router forwarding. On the host desktop, sign in and enable `T3 Connect` in `Settings → Sharing & access`. For a command-line host, run `t3 up` and choose T3 Connect.

1. Finish linking the host to your T3 Connect account.
2. Open the mobile app and sign in to that same account.
3. Choose the linked environment.
4. Open the thread you want to follow or send work to.

For a headless host, the CLI gives you a browser URL and short authorization code. You can open the link on your phone, verify the code, and approve there. The command continues on the host without requiring an OAuth callback port forward.

Account sign-in and host availability are separate. A saved account does not keep a sleeping machine reachable. On Linux and macOS, command-line setup can use a background service. Windows needs the desktop app or a terminal server to remain running.

## Pair with a local or private-network address

Use direct pairing when the phone can reach the host over a LAN or private network. On the host, enable `Network access` in `Settings → Sharing & access`. A command-line service can enable it with `t3 up --lan`.

1. Generate a pairing link on the running host. From a terminal, use `t3 pair`.
2. Scan the QR code or paste the pairing URL into `Add environment` on your phone.
3. Return to the saved environment for later connections.

Create a fresh one-time link for each device. You do not need to retain the original token after pairing. Protect pairing URLs as you would passwords.

Use the machine's reachable address. A URL containing `127.0.0.1` points at the phone when opened there. For an HTTPS server, include `https://`; entering an IP address without a scheme selects HTTP. On Android, an endpoint signed by your own certificate authority requires that CA installed as a CA certificate in system security settings.

The [remote access guide](/learn/remote/remote-access) covers Tailscale HTTPS and other routes when your phone leaves the local network.

## Keep one machine reachable in several places

Open the machine under `Settings → Environments` and choose `Edit` to inspect or reorder routes. A machine can have LAN, private-network, and T3 Connect paths. T3 Code tries the first route that connects.

Use `Add route` to introduce another address for a saved machine. Pairing an existing machine through an unknown address is refused until that address is added as a route. When the host permits network access, a connected environment can also supply current LAN and Tailscale addresses.

On returning to the app or changing networks, T3 Code checks connection health and can restore the connection. Cached content can remain readable while offline. Reading old content is not proof that the host is currently reachable.

## Follow agent work and respond from your phone

Use the mobile app to open agent threads, follow replies, and send further direction to the host. [Mobile notifications](/learn/remote/mobile-notifications) can alert you when work ends, fails, or needs approval or input. Tapping an alert opens its thread.

You can also watch mobile testing. In an agent's thread, tap the device button above the composer to view and control its simulator or emulator. The [Device panel guide](/learn/remote/devices) explains platform requirements and remote streaming limits.

If you have shared a thread through [guest links](/learn/remote/guest-links), the mobile app lets you send or dismiss the guest's proposed messages. Your review still determines whether those messages run as agent turns.

For examples of visual agent work, continue with [Agents sucked at UI (until today)](/learn/videos/agents-sucked-at-ui).

## Next steps

- Use the [remote and mobile overview](/learn/remote) to plan your host and client setup.
- Configure [mobile notifications](/learn/remote/mobile-notifications) after connecting successfully.
- Follow [T3 Connect troubleshooting](/learn/remote/t3-connect-troubleshooting) if the host appears offline or sign-in fails.
