# Prompt links

A prompt link opens T3 Code with a prompt ready to send. Use one to share a prompt on social
media, or to put a one-click fix in a pull request comment.

A link never runs anything. It opens a draft. You read the prompt, then press Send. A link cannot
change your permission mode, branch, or worktree. Your own defaults apply.

## Make a link

Open the command palette and choose **Copy prompt link**. It copies the draft in the composer.
When the project is on GitHub, **Copy prompt link with repo and model** also adds the repository
and the model you picked. Sent messages have a **Copy prompt link** button too.

A copied link points at the address you open T3 Code at in a browser, such as your computer's
network or Tailscale address. When no other device can reach that address, the link starts with
`t3code://` instead, which opens the installed app.

You can also write a link by hand, with your own address in place of `your-server:3773`:

```
http://your-server:3773/new?prompt=Rate%20my%20swearing
http://your-server:3773/new?prompt=Fix%20the%20build&repo=owner/name&provider=codex&model=gpt-5.5
t3code://new?pr=owner/name/123&prompt=Fix%20the%20failing%20check
```

| Parameter  | Meaning                                                                       |
| ---------- | ----------------------------------------------------------------------------- |
| `prompt`   | The prompt. Required, except on pull request links. At most 8,000 characters. |
| `repo`     | A GitHub repository, as `owner/name` or its URL.                              |
| `provider` | A provider such as `codex` or `claude`.                                       |
| `model`    | A model of that provider, by its id or name.                                  |
| `pr`       | A GitHub pull request, as `owner/name/123` or its URL.                        |

Encode the prompt for a URL. In JavaScript, use `encodeURIComponent`.

## Open a link

A link to your server opens in that browser. A `t3code://` link opens the desktop or mobile app.

- **No `repo`**: the draft opens without a project, on the machine you used last.
- **`repo`**: the draft opens in your most recently used project for that repository. A fork
  counts only for its own owner. When you do not have the repository, choose **Clone** or **Use
  without project**.
- **`provider` and `model`**: used when you have that provider set up. Otherwise your default
  model is used, and T3 Code tells you.
- **`pr`**: opens the thread linked to that pull request on any connected machine, with the prompt
  in its composer. When no thread is linked, the draft goes on the pull request branch in a new
  worktree. T3 Code checks the code out only after you confirm, because the checkout runs your
  setup script on it.

A thread link with a prompt, such as `http://your-server:3773/<environment>/<thread>?prompt=…`,
puts the prompt in that thread's composer. If you already typed a draft there, T3 Code asks
before it replaces it.

T3 Code removes characters you cannot see, such as zero-width and hidden tag characters, because
they can hide instructions for the agent. When a prompt had them, T3 Code warns you that it may be
malicious.

## Share a thread

**Copy thread** copies a link such as `http://your-server:3773/threads/<environment>/<thread>`, on
the address of the machine that runs the thread. Paste it anywhere, such as Slack, a GitHub
comment, or your notes. Opening it shows the thread in that machine's web app, so it works from any
device that can reach the address and is paired with it. When no such address is known, the link
starts with `t3code://` and opens the thread in the desktop or mobile app. Pasted into a composer,
a copied thread becomes its chip.
