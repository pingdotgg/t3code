# T3 Code development Agent

An [agentctl](https://github.com/digdir/digdir-agents) Agent for developing this fork inside a
Sandbox. It builds on the [agentctl desktop base image](https://github.com/digdir/digdir-agents/tree/main/images/agentctl-base),
which brings Claude Code, Codex, Chromium and a desktop for the Electron client that agents drive
with the `desktop` helper and the `computer-use` skill, and adds Node 26, `vp`, Rust, Podman and
`agentctl`/`agentd` for nested Agents. It clones the fork into `/home/agent/code/t3code` at boot.
The `demo-video` skill films that desktop into captioned demo videos with fframes.

| Variant        | Image and checkout                                                       |
| -------------- | ------------------------------------------------------------------------ |
| default        | Published image, fresh clone of `martinothamar/t3code`, `upstream` added |
| `nested`       | Published image, reduced to fit inside the default Agent                 |
| `nested-build` | `nested`, with the image built from this checkout's Dockerfile           |

The manifest needs agentctl `0.1.0-preview.15` or later; earlier releases refuse its `accounts` or
merge its variants differently.
The Agent pushes and opens pull requests as the GitHub login `default`. Its token needs Contents,
Pull requests and Workflows read and write on `martinothamar/t3code`: upstream syncs change
`.github/workflows`, which GitHub refuses without Workflows, so give a fine-grained token if a
browser sign-in lacks it.

```sh
agentctl github login default
agentctl apply -f agents/dev/agent.yaml --wait
agentctl attach session/s1 --agent t3code-dev   # creates the Session on first attach
```

`agentctl vnc t3code-dev --web --open` shows the desktop, and the SSH alias `agentctl-t3code-dev`
connects editors and T3 Code itself.
