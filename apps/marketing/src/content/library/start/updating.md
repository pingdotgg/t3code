---
title: "Update T3 Code"
description: "Update T3 Code across desktop apps and connected servers, switch Stable or Nightly tracks, handle version mismatches, and recover from failed updates."
updated: 2026-11-04
sources:
  - label: "Updating T3 Code"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/updating.md"
  - label: "Installation and Nix updates"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/install.md"
  - label: "Threads from older versions"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/thread-migration.md"
  - label: "Release channels"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/operations/release.md"
faq:
  - question: "How do I update T3 Code and all connected servers?"
    answer: "Use the T3 Code update button at the bottom of the sidebar. It updates outdated providers, then servers, then the desktop app; the confirmation lists machines it skips and why."
  - question: "Can I switch T3 Code from Nightly to Stable?"
    answer: "Change Settings \u2192 About \u2192 Update track in the T3 Code desktop app. Database compatibility can block a switch; a background service moving to an older Stable release needs t3 update --channel stable --allow-downgrade on its host."
  - question: "Will T3 Code resume agents after an update?"
    answer: "Continue threads after restarts is on by default in T3 Code Settings \u2192 Maintenance. It resumes supported active threads when T3 Code starts again, but terminal commands can stop and threads awaiting your input do not resume automatically."
  - question: "Why does T3 Code refuse to connect after an update?"
    answer: "T3 Code clients and servers must speak the same orchestration protocol. Update the machine named in the version notice and reconnect."
---

T3 Code updates can involve the app you use, servers on other computers, and the providers running there. Use the sidebar update button for connected machines, or follow the update action shown in `Settings → Environments`. Check the named host before running a manual command.

## Prepare active work before updating

Server updates restart connections and can interrupt agents and terminal commands. Saved threads, settings, and project files remain. The update confirmation counts running threads that restarts will interrupt and shows how many can resume afterward.

`Settings → Maintenance → Continue threads after restarts` is on by default. It resumes supported active threads after updates, crashes, or machine restarts, once T3 Code starts again. The setting does not enable automatic startup. Threads without saved provider resume state need a new message.

A thread waiting for your approval, answer, or secret does not resume automatically. Archived, snoozed, or settled threads do not resume either. After three automatic resumes in a row, the thread waits for your next message. Terminal commands can still be interrupted, so save or finish work that needs an uninterrupted shell.

Before a major server update, the migration documentation recommends stopping the server and copying its `userdata` directory to a safe location. The default is `~/.t3/userdata`; a server using `--base-dir <path>` uses `<path>/userdata`. Keep that recovery copy unchanged.

## Update connected machines together

1. Hover the update button at the bottom of the sidebar to inspect the planned changes.
2. Open the update confirmation and review skipped machines and interrupted threads.
3. Start the update and keep the client open while machines install and reconnect.
4. Use `Retry` for a failed server, or follow manual instructions in `Settings → Environments`.

T3 Code updates outdated providers first, servers second, and the desktop app you are using last. Servers move to the version the desktop app is installing, or the web app's version. Background services keep their current channel, and remote desktop apps install the latest release from their own channel.

The desktop app restarts after each server has started its restart and a short countdown completes. Choose `Later` to keep working and restart through the update button when ready. A server still restarting finishes independently.

## Choose the correct manual update path

The offered action depends on how the named server runs:

| Action                   | Your next step                                                           |
| ------------------------ | ------------------------------------------------------------------------ |
| `Update server`          | Keep the client open through installation and reconnection               |
| `Update the desktop app` | Update on the computer that hosts the server                             |
| `Copy update command`    | Run the copied command on the host, then restart normally                |
| `Copy relaunch command`  | Stop the host's command-line server and relaunch with the copied command |

For a standalone CLI installation, `t3 update` moves to the newest release. When a client names a required version, use the exact-version command:

```sh
t3 update <client-version>
```

Replace the placeholder with the version shown in the notice. The command asks before restarting a background service. If you decline, use `t3 service restart` when ready. A manually started server needs a stop and restart with its usual options afterward.

For an `npx` server, there is no installed command to update. Stop it and relaunch the requested version with the same subcommand and options:

```sh
npx t3@<client-version>
```

Nix installations use Nix updates instead of the in-app updater or `t3 update`. Intel Mac servers built from source need `git pull` and a rebuild. See the [macOS](/learn/start/install-macos), [Windows](/learn/start/install-windows), and [Linux](/learn/start/install-linux) install guides for their package choices.

## Switch between Stable and Nightly

In the desktop app, open `Settings → About → Update track`. Review the connected machines it will move and those it will skip. T3 Code moves remote servers and remote desktop apps first, then reinstalls the current app. Threads, settings, and data stay.

A background service cannot move remotely to an older release. Run this on its host when you deliberately need that downgrade:

```sh
t3 update --channel stable --allow-downgrade
```

Database changes can block a switch if the target release cannot support them, or T3 Code cannot confirm compatibility. Follow the dialog: update on the current track first or wait for the target track to include those changes. A Mac desktop app must switch on that Mac.

## Resolve a failed update or incompatible version

A client and server must speak the same orchestration protocol. Update the side named by the connection notice, then reconnect. Updating the device in your hand does not update a different computer running the server.

Retry the offered action once after a failure. A server checks that the release is installable before restarting, and stays running if it is unavailable. A failed service update can roll back to its previous version.

If a DEB update cannot show a password prompt, download a new DEB from [the download page](/download) and reinstall it. If an old macOS Alpha update leaves no open app, open `T3 Code (Beta)` from Applications and replace the old Dock shortcut. If startup fails, the failure window offers an available update or links the last version that started.

For earlier orchestration versions, read [thread migration](/learn/threads/thread-migration). Conversation text can migrate without old tool history, diffs, or a live provider session. This differs from the [welcome wizard](/learn/start/welcome-wizard), which imports recent provider conversations.

## Update from a phone

Open `Settings → Environments`, select the host, and choose `Check for updates`. Keep the mobile app open while the host updates and reconnects. Hosts that require manual updates show instructions instead.

App Store and Google Play releases update through their stores. Mobile clients can also download compatible updates in the background and apply them when you leave the app. See [mobile apps](/learn/remote/mobile-apps) for the client and host relationship.

## Next steps

- Use [official download verification](/learn/start/verify-official-download) for replacement installers from [Download T3 Code](/download).
- Return to [Get started](/learn/start) or consult the [T3 Code FAQ](/learn/start/faq) for remaining setup questions.
- Review [thread migration](/learn/threads/thread-migration) before resuming important older conversations.
