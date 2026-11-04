---
title: "Git, terminal, and previews"
description: "Use T3 Code to review agent diffs, create pull requests, read terminal history, capture windows, and inspect visual replies."
updated: 2026-11-04
sources:
  - label: "Source control"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/source-control.md"
  - label: "Terminal history"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/terminal.md"
  - label: "Visual replies"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/html-renders.md"
  - label: "SnapShots"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/snap-shot.md"
  - label: "Import browser sessions"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/browser-import.md"
  - label: "Use T3 Code as your default browser"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/default-browser.md"
faq:
  - question: "Can I review Git diffs in T3 Code?"
    answer: "T3 Code shows a turn's changes, branch comparisons, local commits, and pull request diffs. Choose the comparison that matches the work you want to review."
  - question: "Can T3 Code show HTML previews in chat?"
    answer: "T3 Code supports visual replies: self-contained HTML pages that agents publish above their written replies. They work on web, desktop, and mobile."
  - question: "Does T3 Code still have a terminal?"
    answer: "T3 Code has terminal sessions whose retained output lives on the environment server. You can read scrollback and copy the retained output."
---

T3 Code brings Git review, terminal output, browser sessions, and visual replies into your agent workflow. Use each surface to inspect a different part of the result: changed code, command output, a live page, or a visual explanation.

## Review what an agent changed

Start with [source control and pull requests](/learn/workspace/source-control) when you need to approve code or prepare a change for review. A turn diff focuses on the agent's own work during that turn. A branch comparison answers the wider question of what will change against the base branch.

T3 Code integrates with GitHub, GitLab, Forgejo, Gitea, Bitbucket, Azure DevOps, and GitCafe. Authentication belongs on the machine running the environment server. Connecting from another device does not move that setup onto the device in your hand.

## Choose the right way to inspect a result

| Your task                                        | Start here                                                              |
| ------------------------------------------------ | ----------------------------------------------------------------------- |
| Read a command's output or copy a failure        | [Terminal history](/learn/workspace/terminal)                           |
| Ask for a chart, mockup, or annotated comparison | [Visual replies and HTML renders](/learn/workspace/visual-replies)      |
| Give an agent the window you are looking at      | [SnapShots](/learn/workspace/snapshots)                                 |
| Reuse a browser login in the preview browser     | [Import browser sessions](/learn/workspace/browser-import)              |
| Open links from other Mac apps inside T3 Code    | [Use T3 Code as your default browser](/learn/workspace/default-browser) |

These features serve different directions of communication. A SnapShot gives the agent an image and, when available, app text. A visual reply gives you an HTML explanation. Browser import copies cookies into a preview profile so you can reuse a signed-in session.

Use a live browser session when you need to interact with a site. Ask for a visual reply when the result itself should explain a comparison or let you explore an idea. Read a diff when the decision concerns code that will land in a repository.

## Keep evidence with the task

A useful review combines several views. Read the change, inspect the relevant command output, and ask for visual evidence when appearance matters. Name the comparison you need so the agent knows whether you want the last turn, the whole branch, or a before-and-after image.

Terminal history is bounded. Visual replies belong to their thread and are deleted with it. Browser import is a one-time cookie copy. Those differences matter when you decide what evidence to preserve outside the immediate conversation.

## Next steps

- Learn how to [organize work into threads](/learn/threads/working-with-threads) before starting separate tasks.
- Compare the [app and terminal workflows](/learn/concepts/gui-vs-terminal) to decide where to do each part of your work.
- [Download T3 Code](/download) to use the desktop capture and browser-import features.
