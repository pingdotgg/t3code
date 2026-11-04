---
title: "Share prompts with prompt links"
description: "Create T3 Code prompt links that open reviewable drafts, target a repository or pull request, and preserve the recipient's own permission defaults."
updated: 2026-11-04
sources:
  - label: "Prompt links"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/prompt-links.md"
  - label: "Messages and context"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/composer.md"
faq:
  - question: "Does a T3 Code prompt link run the prompt automatically?"
    answer: "A T3 Code prompt link opens a draft. You review it and press Send; the link cannot change your permission mode, branch, or worktree."
  - question: "How do I make a T3 Code prompt link?"
    answer: "In T3 Code, open the command palette and choose Copy prompt link to copy the composer draft. Sent messages also have a Copy prompt link button."
  - question: "Can a prompt link target a GitHub pull request?"
    answer: "T3 Code accepts a pr parameter containing owner/name/123 or a GitHub pull request URL. It opens an existing linked thread, or offers a new worktree on the pull request branch after confirmation."
  - question: "Does sharing a T3 Code thread link make it public?"
    answer: "A regular T3 Code thread link is visible only to someone connected to the machine running that thread. Copying the link does not grant that connection."
---

T3 Code prompt links open a prepared prompt as a draft for the recipient to review and send. You can include a GitHub repository, provider, model, or pull request, while the recipient's own permission, branch, and worktree defaults remain in control.

## Copy a prompt from the composer

1. Write the request in the composer.
2. Open the command palette.
3. Choose **Copy prompt link**.
4. Paste the link where you want to share the request.

The command copies the current draft. Sent messages also offer **Copy prompt link**, so you can reuse a request after sending it.

When the project is on GitHub, **Copy prompt link with repo and model** adds the repository and selected model. Choose this when the request depends on a particular codebase. Use the basic prompt link when the recipient should choose their own project or start without one.

A link opens a draft and never runs work by itself. The recipient reads the prompt and presses **Send**. It cannot change permission mode, branch, or worktree. Treat the draft as instructions to review, even when the link comes from a familiar comment or social post.

See [messages and context](/learn/threads/messages-and-context) when the request also needs files, screenshots, or references. A prompt link prepares prompt text; do not assume it transfers the source conversation's attachments.

## Build a prompt link by hand

Use the official hosted app's `/new` route and URL-encode the prompt text. For example:

```text
https://app.t3.codes/new?prompt=Explain%20the%20failing%20test
https://app.t3.codes/new?prompt=Review%20this%20repository&repo=owner/name
https://app.t3.codes/new?pr=owner/name/123&prompt=Investigate%20the%20failing%20check
```

These are placeholder examples. Replace the repository and pull request with your actual target. In JavaScript, use `encodeURIComponent` for the prompt value so spaces and punctuation do not alter the URL's parameters.

| Parameter  | What to supply                                                             |
| ---------- | -------------------------------------------------------------------------- |
| `prompt`   | Prompt text, up to 8,000 characters; required except on pull request links |
| `repo`     | A GitHub repository as `owner/name` or its URL                             |
| `provider` | The provider identifier, such as `codex` or `claude`                       |
| `model`    | The selected provider's model ID or name                                   |
| `pr`       | A GitHub pull request as `owner/name/123` or its URL                       |

Provider and model parameters apply when the recipient has that provider configured. Otherwise, T3 Code uses the recipient's default model and tells them. A shared link does not configure a missing provider on their behalf.

## Understand where the draft opens

On `app.t3.codes`, the link first offers a destination: the desktop or mobile app, a browser connected to a machine, or the download page. **Remember my choice** skips this choice next time. If you need to install the app, use the [official download page](/download).

Without `repo`, the draft opens without a project on the machine used last. With `repo`, it uses the recipient's most recently used project for that repository. A fork matches only its own owner. If the repository is absent, the recipient can choose **Clone** or **Use without project**.

Check the target before sending. A generic prompt can make sense in a scratch thread, while a build failure usually needs the matching repository. The [thread workflow](/learn/threads/working-with-threads) explains project and worktree selection.

## Open a prompt against a pull request

A `pr` link looks for the thread linked to that pull request across connected machines. If found, T3 Code puts the prompt in its composer.

If no thread is linked, T3 Code prepares a draft on the pull request branch in a new worktree. It checks out the code only after confirmation because checkout runs the setup script on that code. Read that step before continuing with an unfamiliar pull request.

Use a concrete request such as investigating a named failing check. The link identifies the work, while your prompt states the result you want. For the review workflow around that request, see [source control and pull requests](/learn/workspace/source-control).

## Add a prompt to an existing thread link

A link shaped like `https://app.t3.codes/<environment>/<thread>?prompt=…` puts the prompt into that thread's composer. If a draft is already present, T3 Code asks before replacing it.

T3 Code removes invisible characters, including zero-width and hidden tag characters, that could hide instructions. When it finds them, it warns that the prompt may be malicious. Review the visible draft before sending rather than assuming the URL preview showed every instruction.

## Share a thread instead of a prompt

Use **Copy thread** to share a conversation reference, shaped like `https://app.t3.codes/threads/<environment>/<thread>`. On a phone with T3 Code installed, it opens in the app. Elsewhere it offers an opening destination.

Only a person connected to the machine running that thread can see it. The URL alone does not grant access. Read [guest links](/learn/remote/guest-links) when the task is sharing access with someone else.

## Next steps

- Choose the destination with [working with threads](/learn/threads/working-with-threads), then add evidence through [messages and context](/learn/threads/messages-and-context).
- Return to [threads and messages](/learn/threads) for the distinction between shared prompts, references, and handoffs.
