# Computer access

Agents can use apps on the Mac that runs T3 Code, and your open browser tabs
and sign-ins there. Both are off by default and available on macOS only for now.
Turn them on in **Settings → Integrations → Computer**. Turning one on opens its
setup. Changes apply when an agent session next starts.

Codex threads use Codex's own Computer Use, so these settings do not change
them. Claude, Cursor, Grok, Antigravity, ACP Registry, and OpenCode 1.x threads
use the tools below. OpenCode 2 and Pi threads do not get them yet.

## Use apps

**Agent computer access** gives agents [Cua Driver](https://cua.ai/docs/cua-driver),
which clicks, types, and reads apps in the background without moving your
cursor. Setup installs Cua Driver, then asks you to allow Accessibility and
Screen Recording for **CuaDriver**. The permissions belong to Cua Driver, not to
T3 Code. If CuaDriver is missing from **Screen & System Audio Recording**, click
**+** and add it from Applications.

While an agent uses your computer, the composer shows **Using your computer**
with a **Stop** button. The agent's Cua session, and its cursor, ends when the
turn ends, when you stop it, when the agent errors, and when T3 Code closes. The
next turn starts a new session.

## Use your browser tabs

**Agent browser tabs** gives agents Chrome DevTools MCP, connected to the
Chromium browser you already have open: Chrome, Helium, Brave, Edge, or
Chromium. Agents still use T3 Code's own browser for other web work.

Setup lists the browsers it finds. In the browser you want, open its
`inspect/#remote-debugging` page, such as `chrome://inspect/#remote-debugging`,
and check **Allow remote debugging**. Agents connect to the browser that has it
on. T3 Code installs Chrome DevTools MCP when you finish, which needs Node.js on
the computer that runs T3 Code.

The browser asks you to allow each connection. An agent with access can see
every window in that browser's profile, so turn this on only when you need it.

## Remote connections

Both tools run on the Mac that runs T3 Code. When you connect from another
device, agents use that Mac, not the one in front of you. Installing works
remotely, but macOS shows the permission prompts, and the browser shows its
remote debugging switch and connection prompts, on that Mac. Someone at that
Mac has to approve them.
