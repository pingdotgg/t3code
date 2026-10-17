# agentctl Sandboxes

The T3 Code server on a computer finds the [agentctl](https://github.com/digdir/digdir-agents)
Agents there and serves each running one as its own environment, so every client connected to that
server sees them: the desktop app, a browser on your phone or another computer, and the mobile
app. Each Sandbox gets one project, named after the Agent, at its working directory: the same place
agentctl Sessions start, so agents can work across every repository in it. Agents in a Sandbox use
the provider credentials agentctl gives it.

## Before you start

- Sandboxes work wherever agentctl runs: macOS, Linux and Windows. The `agentctl` command must be on
  the `PATH` of the T3 Code server on that computer, which the desktop app and `t3 serve` started
  from a shell both have.
- Run `agentctl ssh-config install` once, so the server can reach `agentctl-<name>` hosts over SSH.
- Give the Agent SSH access in its manifest with `access: [{type: ssh}]`. agentctl needs an image
  with OpenSSH and systemd for that.
- To use Sandboxes from another device, connect it to the computer's T3 Code server as you would for
  any thread there; see [Remote access](./remote-access.md). The Sandboxes come along: the server
  passes each one's traffic through, so nothing else needs to reach them.

## Use a Sandbox

- **Start a thread in one.** Pick the Sandbox's project for a new thread, as you would any project.
  If the Sandbox is stopped, the composer says so and offers **Start**.
- **Create one.** Choose **New Sandbox** in the sidebar or on the Sandboxes page, or **New Sandbox…**
  in the command palette. The first time, add a folder with your manifests, as a path on the
  computer the Sandboxes run on, such as `~/code/agents`; the desktop app on that computer shows a
  folder picker instead. T3 Code finds every `agent.yaml` and `agent.<variant>.yaml` in it. Values
  come from the `.env` beside the manifest, as with `agentctl apply`. The name gets the next free
  number, like `worker-3`. The sidebar follows the Sandbox while agentctl sets it up.
- **Manage them.** **Sandboxes** at the bottom of the sidebar lists each Sandbox with its state,
  resources and threads, and where to start, stop or delete it. Manifest folders are managed there
  too: each shows whether its Git repositories are behind or have local changes, and **Pull**
  fast-forwards them so a Sandbox you create next uses the latest manifests. **Open Sandboxes** in
  the command palette goes there. When you are connected to several computers that run Sandboxes,
  pick one at the top of the page, and in **New Sandbox**.
- **Tell computers apart.** Each Sandbox is named with its computer, such as `worker-1 (desktop)`,
  in pickers and wherever T3 Code names an environment. Once Sandboxes come from more than one
  computer, the sidebar and a new thread's project picker also show the computer beside each
  Sandbox project, since two computers can each have a `worker-1`.
- **Let agents do it.** Agents in a thread on that computer can list, create, start, stop and delete
  its Sandboxes too.

## Good to know

- Stopping keeps the Sandbox's disk. Its threads stay listed and reconnect when it starts again.
  Deleting removes the disk, and with it the Sandbox's project and threads in T3 Code.
- The working directory is usually not a Git repository itself, so T3 Code's turn diffs, restore
  and worktree mode are not available there. **Pull Requests** lists the pull requests of the
  repositories checked out in it, and threads show the status of the pull requests linked to them.
  See [Review and merge](./source-control.md#review-and-merge).
- A new Sandbox starts with the preferences changed in Settings on the computer it runs on, such as
  auto-settle and branch naming. T3 Code copies them once, the first time it connects, and never
  overwrites a setting you changed in the Sandbox. If its manifest has the `pi` harness, Pi is turned
  on there too, unless you already turned it on or off in the Sandbox.
- With **Linked environments** on in Settings → Labs, the computer a Sandbox runs on links it
  automatically, with **Supervised** access, so agents there can hand work to the Sandbox. A new
  Sandbox gets the beta turned on with its other preferences; turn it on in an older Sandbox's
  Labs settings yourself. To keep a Sandbox unlinked, turn the beta off in that Sandbox. See
  [Link another environment](./remote-access.md#link-another-environment).
- A Sandbox always has its project: if you remove it, it comes back the next time T3 Code connects.
- Threads started from T3 Code run outside agentctl Sessions. They do not appear in `agentctl turns`
  or the agentctl TUI, and the manifest's default model does not apply: choose the model in T3 Code.
