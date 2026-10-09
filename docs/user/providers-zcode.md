# ZCode

T3 Code runs [ZCode](https://github.com/zai-org/ZCode), Z.ai's coding agent, through the community
[`zcode-acp-server`](https://github.com/william0wang/zcode-acp) bridge. The bridge drives ZCode's
own app-server, so threads use the same harness, tools, skills, MCP servers, and plan credentials
as the ZCode desktop app, including GLM Coding Plan models.

## Set Up ZCode

1. Install the ZCode desktop app on the machine running the T3 Code server and sign in.
2. Install the bridge: `npm install -g zcode-acp-server`. It needs Node.js 22 or newer.
3. Open T3 Code Settings, add ZCode, and refresh the provider.

The bridge finds the ZCode CLI on `PATH` or inside the desktop app. Set **ZCode CLI path** when
ZCode lives elsewhere, and **ACP bridge path** when `zcode-acp-server` is not on the server's
`PATH`. Set **ZCode data directory** to run an instance against a different `~/.zcode`, for
example a second account.

## Models

ZCode lists its models when a session starts, so a new instance offers only **ZCode default**,
which keeps the model selected in ZCode. After the first turn the picker shows every model your
ZCode account offers, including other providers configured in ZCode. Add a model's full ID as a
custom model to pick it before the first turn, for example
`builtin:zai-coding-plan\GLM-5.3-Flash`. The thinking level comes from ZCode's own options.

## Permission Modes

T3 Code selects the ZCode permission mode that enforces the composer mode:

- **Supervised** runs ZCode in `build` mode: read-only tools continue, everything else asks.
- **Auto-accept edits** runs ZCode in `edit` mode: workspace file edits are allowed, commands ask.
- **Full access** runs ZCode in `yolo` mode.

The **Auto** option is not shown because ZCode's `auto` mode is reserved upstream and denies every
tool. Approvals offer **Approve** and **Decline** for that one action. ZCode's "Always allow in this
project" is not offered, because ZCode keeps it for the project after the thread ends. ZCode's plan
mode is not offered.

## What Carries Over

Threads resume ZCode sessions. ZCode's slash commands and skills appear in the composer's `/` and
`$` menus after a session starts. When a plan's usage cap is reached, the thread shows Limited with
the reset time ZCode reports. The bridge's own remote access and automatic quota resume are turned
off for T3 Code sessions. ZCode does not provide commit messages or thread titles; T3 Code uses
another provider for those.

## Troubleshooting

- If ZCode is unavailable, run `zcode-acp-server` on the server machine and confirm it starts, then
  refresh the provider in Settings.
- If a turn fails to authenticate, open the ZCode desktop app and confirm you are signed in.
- ZCode keeps per-project state in a `.zcode` directory in the workspace.
