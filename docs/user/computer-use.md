# Computer use

Computer use lets agents see and use apps on the computer that runs your T3
Code environment. Every provider gets it: Claude, Codex, Cursor, Grok,
Antigravity, OpenCode, Pi, and ACP agents. It runs through
[Cua Driver](https://cua.ai/docs/cua-driver), which acts on windows in the
background, so agents do not take over your cursor or keyboard while you work.

It works on macOS, Windows, and Linux. It is off by default.

## Turn it on

Open **Settings → Integrations → Computer**, select the environment, and turn
on **Computer use**. Agent sessions started afterwards get the computer use
tools. Turning it off stops the driver; sessions already running lose the tools
on their next start.

What the host needs depends on its OS:

- **macOS:** T3 Code needs Accessibility and Screen Recording. On the Mac that
  runs the environment, the setup walks you through both. From another computer
  or the mobile app, the switch turns on, but someone at that Mac still has to
  grant them from T3 Code there. Choose **Setup** next to the switch to check
  them again later.
- **Windows:** someone must be signed in to the desktop. No permissions are
  needed. Windows Defender may ask once before Cua Driver first runs.
- **Linux:** the host needs a signed-in graphical session. On Wayland, someone
  at the computer approves the screen capture prompt the first time an agent
  looks at the screen.

The desktop app includes Cua Driver. A server started with `npx t3` downloads
the same version into T3 Code's home the first time an agent session needs it.
To use your own build instead, set `T3CODE_CUA_DRIVER_PATH` to its executable
before starting the server.

If you already configured a `cua-driver` MCP server for Codex yourself, Codex
keeps yours and T3 Code does not add a second one.

## Watch the agent work

Each action an agent takes shows in the thread with the app's icon and a plain
title, such as **Clicked in Safari**.

On the web and desktop, a floating card shows the window the agent is driving
and refreshes while the turn runs, then keeps the last frame. The card follows
**Auto-show floating preview** under **Settings → Integrations**. Closing it
stops the capture until the agent's next action. If the host cannot capture
its screen, for example because Screen Recording is off on a Mac, the card
says why.

## Use your browser tabs

**Agent browser tabs** lets agents work in the Chromium browser you already
use on the host, with your open tabs and sign-ins, through Chrome DevTools
MCP. It works with Chrome, Edge, Brave, Helium, and Chromium on every OS.

Turn it on in **Settings → Integrations → Computer**. Setup lists the browsers
it finds on the host. Open the browser's page it shows, such as
`chrome://inspect/#remote-debugging`, and turn on remote debugging. Choosing
**Done** installs Chrome DevTools MCP on the host. The browser asks to allow
each connection, so someone at the host has to approve it.
