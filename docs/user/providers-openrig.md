# OpenRig

T3 Code can run an [OpenRig](https://openrig.dev) team as an ACP agent. A prompt becomes a
queue task on that team; work steps show in the thread, and the team's closing resolution
comes back as the reply.

## Set up OpenRig

1. Install OpenRig on the machine that runs the T3 Code server and keep `rig` on that
   environment's `PATH`. See [OpenRig's docs](https://openrig.dev/docs).
2. Bring up a team with `rig` so there is somewhere for ACP prompts to land.
3. Open **Settings → Providers**, choose **Add provider → Show more → OpenRig**, and
   enable the instance.

If `rig` is not on the server's `PATH`, set **Binary path** to the executable. To send every
prompt to one teammate, set **Target member** to a `member@rig` address (passed as
`rig acp serve --to …`).

Team credentials stay with OpenRig. T3 Code does not keep a separate OpenRig login.

## How a turn works

T3 Code launches `rig acp serve` over ACP. The OpenRig team owns the work; models and
permission rules come from that team. T3 Code still provides projects, threads,
checkpoints, and its MCP tools when the agent accepts them.

You can also add OpenRig through **Local ACP command** with executable `rig` and arguments
`acp` then `serve`. Prefer the dedicated OpenRig provider so the target-member setting stays
obvious.

## Not supported yet

- Commit messages, pull request text, branch names, and thread titles. Pick another provider
  for those.
- Rewinding OpenRig's own conversation after a checkpoint rollback. The next turn starts a
  fresh ACP session.

See [provider setup](./install.md#providers) and [ACP providers](./providers-acp.md).
