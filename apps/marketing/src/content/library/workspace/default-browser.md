---
title: "Use T3 Code as your default browser"
description: "Set T3 Code as your macOS default browser, open links in a thread, understand pull request routing, and switch back when needed."
updated: 2026-11-04
sources:
  - label: "Use T3 Code as your default browser"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/default-browser.md"
  - label: "Threads without a project"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/thread-sidebar.md"
  - label: "Browser import"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/browser-import.md"
  - label: "Open links in setting"
    url: "https://github.com/pingdotgg/t3code/blob/main/apps/web/src/components/settings/IntegrationsSettings.tsx"
faq:
  - question: "Can T3 Code be my default browser?"
    answer: "The T3 Code desktop app can be the default web browser on macOS. Select it in System Settings → Desktop & Dock → Default web browser."
  - question: "Where do external links open in T3 Code?"
    answer: "If the visible T3 Code thread has its browser panel open, an incoming link opens as a new tab there. Otherwise T3 Code starts a thread without a project and maximizes its browser panel on the page."
  - question: "Does making T3 Code my default browser import my logins?"
    answer: "T3 Code has a separate browser-import feature for copying cookies from a supported browser. Setting the default browser controls where links open."
  - question: "How do I stop using T3 Code as my default browser?"
    answer: "Choose another app in macOS System Settings → Desktop & Dock → Default web browser. This replaces T3 Code as the operating system's default browser."
---

T3 Code can be your default web browser on macOS, so links opened from other apps arrive in its browser panel. It uses the visible thread's open browser panel or starts a thread without a project so you can ask an agent about the page.

## Set the default browser on macOS

1. Install the T3 Code desktop app from the [download page](/download) if needed.
2. Open macOS `System Settings`.
3. Go to `Desktop & Dock → Default web browser`.
4. Choose `T3 Code`.
5. Open a web link from another app to check where it appears.

This is the documented macOS workflow. Use it when opening a page is often the start of an agent task: reading it, investigating a problem, or asking a question about its contents. You can reverse the choice in the same system setting.

Setting the operating-system default changes the destination for incoming links. It does not copy your existing browser's cookies. Use [browser import](/learn/workspace/browser-import) separately when the page requires a signed-in session you already have elsewhere.

## Predict which thread receives the link

| State when the link arrives                    | Result                                                                |
| ---------------------------------------------- | --------------------------------------------------------------------- |
| Visible thread shows its browser panel         | A new tab opens in that panel                                         |
| Visible thread does not show its browser panel | A new thread without a project opens with the browser panel maximized |
| Link launches the app                          | The link waits for the environment connection, then opens             |

Before opening a link, consider whether it belongs with the current conversation. An existing browser panel gives the incoming page a place in that visible thread. Otherwise, the new thread gives you a starting point for asking about the page.

A thread without a project still has a working folder under T3 Code's scratch directory. It does not have Git branch, worktree, or diff controls because the folder is not a Git repository. You can later choose `Turn into project` from the thread menu if the work grows into a project.

For more on that distinction, read [working with threads](/learn/threads/working-with-threads). Opening a page and starting repository work are separate decisions, so check the thread's project before asking for code changes.

## Understand special link destinations

Pull request links can open in T3 Code's pull request view when they belong to a connected project and opening pull request links in the app is enabled. Other links continue into the browser panel.

If a review opens as a pull request rather than as a web tab, check that routing setting before treating it as a browser failure. The app is choosing the review view for a recognized project link.

HTML files opened from Finder follow the same browser-panel behavior. [Prompt links](/learn/threads/prompt-links) to `app.t3.codes` are different: they open in the app as a draft. Check whether you are opening a page, a review, or a prompt before deciding which destination to expect.

## Distinguish incoming links from link preferences

T3 Code also has an `Open links in` setting for links in chat and terminal output. That controls links selected inside the app. The macOS default-browser setting controls links handed to the system by other apps.

For links in chat and terminal, holding Command or Control while clicking uses your default browser. If T3 Code is that default, keep that system choice in mind when expecting another application to open.

Generated [visual replies](/learn/workspace/visual-replies) serve another purpose. They are HTML answers inside a conversation, such as diagrams and charts. Setting the default browser helps bring an existing page into an agent workflow; asking for a visual reply asks the agent to create an answer.

## Check connection and login issues

A link that launches T3 Code waits until the app connects to its environment. If the page has not appeared, check the connection before opening the same link repeatedly. Once it opens, inspect the page's account state if authentication matters.

A site asking for login does not establish that default-browser routing failed. Routing can succeed while the browser profile lacks the required session. Import eligible cookies or sign in within the preview browser as needed.

If the agent needs only an image of what you see, use [SnapShots](/learn/workspace/snapshots). That attaches a capture to a draft without requiring the page itself to become a browser task.

## Next steps

- Return to the [workspace guides](/learn/workspace) to compare page browsing with visual explanations and captures.
- Switch back by choosing another browser in `System Settings → Desktop & Dock → Default web browser`.
