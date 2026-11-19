# Computer use

Computer use lets agents see and use apps on the computer that runs your T3
Code environment. It runs through
[Cua Driver](https://cua.ai/docs/cua-driver), which acts on windows in the
background, so agents do not take over your cursor or keyboard while you work.

It works on macOS, Windows, and Linux. It is off by default.

## Turn it on

Open **Settings → Devices → Computer**, choose one environment, and turn
on **Computer use**. On mobile, use **Settings → Threads → Computer**.
Agent sessions started afterwards get the computer use tools. Turning it off
stops the driver immediately; restart existing agent sessions to remove their tools.

What the host needs depends on its OS:

- **macOS:** T3 Code needs Accessibility and Screen Recording. On the Mac that
  runs the environment, the setup walks you through both. From another computer
  or the mobile app, the switch turns on, but someone at that Mac still has to
  grant them there. For a server run from a terminal or service, grant access to
  the process hosting the server in **System Settings → Privacy & Security**.
  Choose **Setup** next to the switch in the desktop app to check its grants again.
- **Windows:** someone must be signed in to the desktop and respond to any
  security prompts for Cua Driver at that computer.
- **Linux:** the host needs a signed-in graphical session. On Wayland, someone
  at the computer may need to approve a screen capture prompt.

The desktop app includes Cua Driver. A server started with `npx t3` downloads
the same version into T3 Code's home the first time an agent session needs it.
To use your own build instead, set `T3CODE_CUA_DRIVER_PATH` to its executable
before starting the server.

If you already configured a `cua-driver` MCP server for Codex yourself, Codex
keeps yours and T3 Code does not add a second one.

## What you see

Each action an agent takes shows in the thread with the app's icon and a plain
title, such as **Clicked in Safari**.
