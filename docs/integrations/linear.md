# Linear Integration

T3 Code connects to [Linear](https://linear.app) so you can turn an issue into a working thread
without copying context by hand. Browse and search your Linear issues straight from a folder in the
sidebar, select one or more, and a new thread opens with its full context already in the composer.

## What You Can Do

- **Import issues into threads** – Click the Linear icon on any folder row in the sidebar to browse
  and search issues. Pick one or several, then import them into a new thread for that folder.
- **Bring the whole issue** – Title, description, acceptance criteria / checklists, labels, priority,
  assignee, state, sub-issues, linked pull requests, comments, and attachment links are all pulled
  into the composer as markdown. Review and edit before you send.
- **Combine or split** – When you select more than one issue, choose whether to **combine** them into
  one task or treat them as **related subtasks**.
- **Browse in bulk** – Open the full Linear browser to filter by team, status, and assignee, page
  through large backlogs, and multi-select issues to import as one thread per issue or a single
  combined thread.
- **Status write-back** – As work progresses, T3 Code moves the linked issue through your workflow:
  **In Progress** when the agent starts, **In Review** when a pull request opens, and **Done** when
  it merges. States are mapped per team by their category (so renamed states still work). Toggle
  each transition (and optional progress comments) in **Settings → Linear → Status write-back**.

## Getting Started

1. In Linear, open **Settings → Security & access → Personal API keys** and create a key.
2. In T3 Code, open **Settings → Linear** and paste the key, then **Connect**. The key is stored
   securely on the server (via the encrypted secret store) and is never shown again.
3. The connection status shows the authenticated Linear account once the key is validated.

Alternatively, set the `T3CODE_LINEAR_API_TOKEN` environment variable on the machine running T3 Code
(and optionally `T3CODE_LINEAR_API_BASE_URL` to override the API endpoint). A token stored through the
Settings UI takes precedence over the environment variable.

## Importing

1. Hover a folder in the sidebar and click the **Linear** icon (next to the new-thread button).
2. Search for issues, tick the ones you want, and choose **Combine into one task** or **As related
   subtasks** when multiple are selected.
3. Click **Import**. A new draft thread opens for that folder with the issue context pre-filled —
   review it and send to start working.

## Requirements & Troubleshooting

- **Not connected** – Add a personal API key in **Settings → Linear**, or set
  `T3CODE_LINEAR_API_TOKEN` and restart T3 Code.
- **Token rejected** – Regenerate the key in Linear and reconnect; keys can be revoked from Linear’s
  security settings.
- **No issues found** – Free-text search matches issue titles/identifiers; clear the search box to see
  recent issues.
