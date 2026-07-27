---
name: create-pr
description: Creates a focused GitHub pull request from the current branch by inspecting its diff, composing accurate metadata, pushing the branch, and invoking the GitHub CLI. Use when the user asks to create a PR, draft a PR description, or prepare current branch changes for review.
---

# Create PR

Create a reviewable PR that accurately describes the branch's changes. Use `gh` for GitHub operations.

## Workflow

1. Inspect the repository and determine the base branch. Prefer the branch's configured upstream PR base, then the repository default branch. Do not assume `main`.

   ```sh
   git status --short
   git branch --show-current
   git remote -v
   gh repo view --json defaultBranchRef --jq .defaultBranchRef.name
   git log --oneline <base>..HEAD
   git diff --stat <base>...HEAD
   git diff --check <base>...HEAD
   ```

2. Read the relevant diff and tests to establish:
   - the user-facing intent and implementation approach;
   - type (`feat`, `fix`, `refactor`, `docs`, `test`, `perf`, `chore`);
   - any breaking changes, migrations, rollout constraints, or unvalidated risk;
   - testing actually performed. Never claim testing that did not run.

3. Keep the PR focused. Exclude unrelated existing worktree changes. If the branch combines independent concerns or is unusually large, recommend splitting it rather than obscuring the scope.

4. Compose a concise imperative title, preferably conventional-commit style and under 72 characters. Write a body containing only applicable sections:

   ```md
   ## Summary

   - <meaningful change and why>

   ## Testing

   - <commands run, or `Not run (not requested)`>

   ## Breaking changes

   - <migration impact, if any>
   ```

   Add issue-closing keywords, screenshots, rollout notes, or reviewer context only when supported by the changes or supplied by the user. Describe the why and externally observable behavior, not a file-by-file diff.

5. Before creating the PR, present the base branch, title, and complete body for confirmation. Ask only for missing material choices: title/body changes, base branch, draft status, reviewers, or labels.

6. Check GitHub CLI authentication and an existing PR for the branch:

   ```sh
   gh auth status
   gh pr view --json url --jq .url
   ```

   If a PR exists, report its URL and update it only with explicit user approval. If the branch has no upstream, or commits have not been pushed, push it after confirmation:

   ```sh
   git push -u origin "$(git branch --show-current)"
   ```

7. Create the confirmed PR:

   ```sh
   gh pr create --base "<base>" --title "<title>" --body "<body>"
   ```

   Use `--draft`, `--reviewer`, and `--label` only when requested. Return the PR URL.

## Safety rules

- Do not commit, amend, rebase, force-push, or discard changes unless the user explicitly requests it.
- Never include credentials, generated secrets, or unrelated files.
- Surface authentication, push, base-branch, and existing-PR failures directly; do not fabricate a successful PR.
