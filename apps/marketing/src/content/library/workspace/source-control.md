---
title: "Source control and pull requests"
description: "Review agent diffs in T3 Code, connect your Git host, create pull requests, and choose turn, branch, or commit comparisons."
updated: 2026-11-04
sources:
  - label: "Source control"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/source-control.md"
  - label: "Working with threads"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/thread-sidebar.md"
  - label: "Pull request file revisions"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/internals/pull-request-file-revisions.md"
  - label: "GitHub integration package"
    url: "https://github.com/pingdotgg/t3code/blob/main/packages/source-control-github/package.json"
  - label: "GitLab integration package"
    url: "https://github.com/pingdotgg/t3code/blob/main/packages/source-control-gitlab/package.json"
  - label: "Bitbucket integration package"
    url: "https://github.com/pingdotgg/t3code/blob/main/packages/source-control-bitbucket/package.json"
  - label: "Azure DevOps integration package"
    url: "https://github.com/pingdotgg/t3code/blob/main/packages/source-control-azure-devops/package.json"
  - label: "Forgejo integration package"
    url: "https://github.com/pingdotgg/t3code/blob/main/packages/source-control-forgejo/package.json"
  - label: "GitCafe integration package"
    url: "https://github.com/pingdotgg/t3code/blob/main/packages/source-control-gitcafe/package.json"
faq:
  - question: "How do I create a pull request from T3 Code?"
    answer: "Use the thread's Git actions to commit, push, and create a pull request in T3 Code. T3 Code can generate its title and description from the changes and the thread's work."
  - question: "Which Git hosts does T3 Code support?"
    answer: "T3 Code integrates with GitHub, GitLab, Forgejo, Gitea, Bitbucket, Azure DevOps, and GitCafe. Forgejo and Gitea share one integration entry."
  - question: "Why does a T3 Code turn diff omit files from a pull or rebase?"
    answer: "T3 Code keeps a turn diff focused on the turn's own edits, commits, and conflict fixes. Use the branch comparison to review all changes against the base branch."
  - question: "Does each T3 Code thread have its own worktree?"
    answer: "Choose New worktree when starting a T3 Code task that needs a separate branch and working directory. You can also start another thread in an existing worktree."
---

T3 Code lets you review agent diffs, commit and push changes, and create pull requests from a thread's Git actions. It supports GitHub, GitLab, Forgejo, Gitea, Bitbucket, Azure DevOps, and GitCafe, with host-specific authentication and review capabilities.

## Connect your Git host on the right machine

Install Git and configure authentication on the machine running your environment server. For remote work, that means the remote machine. Open `Settings → Source control` and choose `Rescan` after signing in.

| Host              | Supported authentication path                                             |
| ----------------- | ------------------------------------------------------------------------- |
| GitHub            | Saved token, server environment token, or authenticated GitHub CLI        |
| GitLab            | GitLab CLI with `glab auth login`                                         |
| Forgejo and Gitea | Forgejo CLI `fj` or Gitea CLI `tea`                                       |
| Bitbucket         | Access token, or Atlassian account email and API token, saved in Settings |
| Azure DevOps      | Azure CLI with its DevOps extension                                       |
| GitCafe           | Saved token, `CAFE_TOKEN`, or authenticated `cafe` CLI                    |

GitHub does not require its CLI when you save a token in T3 Code. A saved token takes precedence over environment credentials and CLI account selection. If you use the CLI, the documented minimum is GitHub CLI 2.81.0.

Forgejo and Gitea share an integration entry. Use a full repository URL to identify the server when multiple Forgejo servers are configured. API authentication and Git transport authentication remain separate concerns. A connected host account does not prove an SSH key or HTTPS credential can push the remote.

## Choose a worktree before starting a separate task

Select `New worktree` when a task needs its own branch and directory. To continue in a checkout that already exists, choose `New thread in this worktree` from the branch toolbar.

This choice matters when you [run several coding agents in parallel](/learn/concepts/run-agents-in-parallel). Give independent changes separate workspaces, then review each branch's result. A new conversation alone does not establish that its files are isolated.

## Review the right diff

| Review question                                | Comparison to use                        |
| ---------------------------------------------- | ---------------------------------------- |
| What did this agent turn contribute?           | The turn's changed files and diff        |
| What will this branch change against its base? | Branch comparison                        |
| What did one local commit change?              | `Commits` in the Diff pane source picker |

A pull, merge, or rebase can bring in many files. T3 Code leaves those incoming changes out of the turn's own file list. Files remain when the turn edited them, committed them, or resolved conflicts in them. Restore still returns the complete saved workspace.

On web and desktop, the commit picker lists the newest 100 commits in the branch comparison. A merge commit is compared with its first parent. Choose the branch comparison before deciding that an omitted turn-diff file is missing from the proposed change.

## Create a pull request from the thread

1. Review the branch comparison and the relevant checks.
2. Use the thread's Git actions to commit the change.
3. Push the branch through Git actions.
4. Create the pull request and inspect its generated title and description.

T3 Code can generate commit messages and review text. Pull request descriptions also use the thread's work, including checks it ran. Set the writing model and style in `Settings → Source control`. `Repository conventions` uses project instructions and recent commit subjects.

Creating a pull request through Git actions links it to the thread automatically. Use `Link pull request` to attach another review. A thread can keep several linked pull requests, including reviews from another repository on the same host.

If a fork pull request badge is missing because several remotes contain the branch, set its upstream to the intended remote. Use [terminal history](/learn/workspace/terminal) to inspect the command result rather than assuming account detection selected the right remote.

## Review files and comments before merging

Open `Pull requests` to read diffs and comments, request reviewers, check out the branch, or merge. GitLab calls these merge requests. On mobile, `Work on PR` attaches the review to a chat and prepares its branch in a worktree when you send the first message.

Mark a file viewed after reading it in the `Code` tab. GitHub viewed marks synchronize with GitHub. For Forgejo, GitLab, Bitbucket, and Azure DevOps, the connected T3 Code server stores the marks. Those marks follow clients using that server, rather than appearing on the host website.

Host capabilities differ. GitCafe pull requests do not yet support line comments. Azure DevOps comment changes require the host website. Bitbucket cannot reopen a declined pull request.

## Fix authentication and review failures

If authentication fails, sign in on the environment server and rescan. For Bitbucket, inspect saved credentials or the running server's environment. If pushing fails while the host account is connected, check the remote's Git credentials separately.

If a review cannot load, open it on the host website while resolving permissions, connectivity, or rate limits. For appearance changes, request [visual evidence](/learn/workspace/visual-replies) alongside the code diff. A readable patch does not show the rendered result.

## Next steps

- Start from an issue with [agent-assisted triage](/learn/threads/triage).
- Use the [workspace guides](/learn/workspace) to combine diffs, command output, and previews during review.
