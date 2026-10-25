# Storyboard

Fill this in and agree it with the developer before installing or filming anything. The
walkthrough below is a filled-in example.

## Brief

- Audience, and what they should be able to do afterwards:
- Length, resolution, audio (silent with captions by default), where the result goes:
- The setup to film (which app build, which Sandboxes and manifests, what data):
- The moment to show:

## Scenes

| #   | Scene | Length | Made from (drawn, or a recording) |
| --- | ----- | ------ | --------------------------------- |
| 1   |       |        |                                   |

## Risks to check in the dry run

-

# Example: T3 Code × agentctl walkthrough

The storyboard agreed with the developer for a coworker who wanted to see how to set up the fork
with agentctl and what using it looks like, then how it was filmed and cut.
[template/src/lib.rs](template/src/lib.rs) is the finished composition.

## Brief

- Audience: a developer who will set it up on their own computer.
- About 3 minutes, 1080p, silent with captions, kept locally.
- The Sandbox is Altinn Studio's desktop Agent, `agents/desktop` in `Altinn/altinn-studio`: it
  already has SSH and VNC access, a desktop, `studioctl` and localtest.
- The moment to show: an agent opens its own desktop in T3 Code's browser tool, the floating
  preview pops up, it moves to the right panel, and the agent installs studioctl, starts localtest
  in a terminal on its desktop and opens localtest in Chromium, all visible beside the chat.

## Storyboard

| #   | Scene                                                                                                                                                    | Length | Made from                       |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ------------------------------- |
| 1   | Cold open: the title over a sidebar of Sandboxes                                                                                                         | ~8s    | Drawn text                      |
| 2   | How it fits together: the laptop's T3 Code reaches a Sandbox over SSH; the agents, T3's server, a desktop and localtest run inside it                    | ~15s   | Drawn diagram                   |
| 3   | Setup: `agentctl claude login`, `agentctl ssh-config install`, clone altinn-studio and fill its `.env`, install the fork's app; the manifest's `access:` | ~45s   | Typed terminal, a manifest card |
| 4   | First Sandbox: add the manifest folder, New Sandbox, `altinn-desktop`, provisioning sped up to Ready                                                     | ~40s   | Recording, zooms on clicks      |
| 5   | In practice: the prompt, the floating preview with "Agent has control", the right panel, the terminal and localtest in Chromium                          | ~75s   | Recording, callouts             |
| 6   | Lifecycle: Stop keeps the disk and threads, Start reconnects, Delete removes everything                                                                  | ~20s   | Recording                       |
| 7   | Recap: the setup commands and links, no outro                                                                                                            | ~10s   | Drawn text                      |

The finished video kept this order with a plain title, and its setup scene typed the commands
before showing the manifest.

Risks checked first, in the dry run:

- The picture through noVNC, a headless browser and T3's stream may be soft. It was legible once
  the panel was widened and the camera zoomed in.
- The agent must choose T3 Code's browser over its own Chromium. The prompt names the browser tool
  and the URL.
- localtest must fit the Sandbox. It needed 4 CPUs and 6 GiB beside the desktop and T3's server.

## How it was filmed

The prompt, typed into a new thread in the Sandbox's project on Claude:

> Show me your desktop in the browser here: open http://127.0.0.1:6080 with your browser tool.
> Then open a terminal on that desktop, install the latest studioctl with its public installer,
> start localtest, and open it in Chromium so I can see it.

`http://127.0.0.1:6080` is the Altinn desktop's noVNC viewer, inside the Sandbox, where T3's
browser runs too. Three takes, recorded in this order to reuse the dry run's Sandbox:

| Take             | Length | What happens                                                                        |
| ---------------- | ------ | ----------------------------------------------------------------------------------- |
| take-thread-1    | 3:01   | The prompt; the popup at 0:26; right panel at 1:37; `env up`; localtest at 2:30     |
| take-lifecycle-1 | 2:23   | Sandboxes page; Stop; Start and reconnect; the thread survives; Delete              |
| take-create-1    | 2:11   | New Sandbox; the manifest list; Create at 0:21; Ready and connected at 1:46; thread |

Cut into segments (`cut.sh TAKE SEGMENT START END SPEED`):

| Segment | Take      | Source   | Speed | Shot                              |
| ------- | --------- | -------- | ----- | --------------------------------- |
| c1      | create    | 0–21s    | 1.5×  | The dialog and the manifest list  |
| c2      | create    | 21–104s  | 8×    | Provisioning                      |
| c3      | create    | 104–112s | 1×    | Running, then connected           |
| c4      | create    | 122–131s | 1×    | New thread                        |
| t1      | thread    | 0–9s     | 1×    | Typing the prompt                 |
| t2      | thread    | 9–30s    | 2×    | The agent starts; the popup       |
| t3      | thread    | 30–94s   | 8×    | The agent's terminal in the popup |
| t4      | thread    | 94–110s  | 1.25× | The right panel, widened          |
| t5      | thread    | 110–144s | 2.5×  | `studioctl env up`                |
| t6      | thread    | 144–158s | 1×    | localtest in Chromium             |
| t7      | thread    | 158–181s | 3×    | The agent's summary               |
| l1      | lifecycle | 3–24s    | 1.5×  | Sandboxes page, Stop              |
| l2      | lifecycle | 30–50s   | 2×    | Start, reconnect                  |
| l3      | lifecycle | 114–121s | 1×    | The thread is still there         |
| l4      | lifecycle | 121–137s | 1.25× | Delete                            |

The result ran 3:24: 40 seconds of drawn scenes up front, 2:40 of shots, 10 seconds of recap.
