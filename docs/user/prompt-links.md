# Prompt links

A prompt link opens T3 Code with a prefilled draft—useful for sharing prompts or adding one-click fixes in pull request comments.

Links **never** auto-send or change your permission mode, branch, or worktree. They only open a draft for you to review and send.

## Create a link

- **From the composer**: Open the command palette and choose **Copy prompt link** (or **Copy prompt link with repo and model** on GitHub projects).
- **From a sent message**: Click **Copy prompt link**.
- **By hand** (URL-encode the prompt, e.g. with `encodeURIComponent`):

A copied link points at the address you open T3 Code at in a browser, such as your computer's
network or Tailscale address. When no other device can reach that address, the link starts with
`t3code://` instead, which opens the installed app.

You can also write a link by hand, with your own address in place of `your-server:3773`:

```
http://your-server:3773/new?prompt=Rate%20my%20swearing
http://your-server:3773/new?prompt=Fix%20the%20build&repo=owner/name&provider=codex&model=gpt-5.5
t3code://new?pr=owner/name/123&prompt=Fix%20the%20failing%20check
```

| Parameter  | Description                                                       |
| ---------- | ----------------------------------------------------------------- |
| `prompt`   | Draft text (up to 8,000 characters). Required unless `pr` is set. |
| `repo`     | GitHub repository (`owner/name` or URL).                          |
| `provider` | Provider ID (e.g. `codex`, `claude`).                             |
| `model`    | Model ID or name for that provider.                               |
| `pr`       | GitHub pull request (`owner/name/123` or URL).                    |

## How links open

Opening a link on `app.t3.codes` asks whether to use the desktop/mobile app, the current browser, or the download page (**Remember my choice** skips this next time).

A link to your server opens in that browser. A `t3code://` link opens the desktop or mobile app.

- **No `repo`**: Opens a no-project draft on your last-used machine.
- **`repo`**: Opens in your most recent project for that repo (or offers **Clone** / **Use without project**).
- **`provider` / `model`**: Applied if configured; otherwise falls back to your default with a notice.
- **`pr`**: Opens the thread linked to that PR, or prepares a new worktree draft on the PR branch after you confirm checkout.
- **Thread prompt link** (`http://your-server:3773/<environment>/<thread>?prompt=…`): Prefills that thread's composer (asks before overwriting an existing draft).

PseudoCode strips invisible characters (such as zero-width and hidden tag characters) and warns you if a prompt contained them.

## Share a thread

**Copy thread** copies a link such as `http://your-server:3773/threads/<environment>/<thread>`, on
the address of the machine that runs the thread. Paste it anywhere, such as Slack, a GitHub
comment, or your notes. Opening it shows the thread in that machine's web app, so it works from any
device that can reach the address and is paired with it. When no such address is known, the link
starts with `t3code://` and opens the thread in the desktop or mobile app. Pasted into a composer,
a copied thread becomes its chip.
