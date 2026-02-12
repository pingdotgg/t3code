# Git Flows Integration Tests

## Overview

Real integration tests that run actual git commands against temporary repos. No mocking.

## Step 1: Extract git functions into `apps/desktop/src/git.ts`

The git functions (`listGitBranches`, `createGitWorktree`, `removeGitWorktree`, `createGitBranch`, `checkoutGitBranch`, `initGitRepo`) and their helper `runTerminalCommand` are currently private in `main.ts`. Extract them into a new `apps/desktop/src/git.ts` module with named exports.

`main.ts` will import and re-use them — no behavior change, just moving code.

**Files modified:**

- `apps/desktop/src/git.ts` — new file with all git functions exported
- `apps/desktop/src/main.ts` — import from `./git` instead of defining inline

## Step 2: Create `apps/desktop/src/git.test.ts`

Integration tests using real temp git repos. Each test group creates a fresh temp directory with `git init`, makes commits, creates branches as needed, and cleans up after.

### Setup/teardown pattern

```ts
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  listGitBranches,
  createGitBranch,
  checkoutGitBranch,
  createGitWorktree,
  removeGitWorktree,
  initGitRepo,
} from "./git";

// Helper: run a raw git command in a dir (for test setup, not under test)
// Helper: create an initial commit (git needs at least one commit for branches)
```

### Test groups

**1. initGitRepo**

- Creates a valid git repo in a temp dir
- listGitBranches reports `isRepo: true` after init

**2. listGitBranches**

- Returns `isRepo: false` for non-git directory
- Returns the current branch with `current: true`
- Sorts current branch first
- Lists multiple branches after creating them
- `isDefault` is false when no remote (no origin/HEAD)

**3. checkoutGitBranch**

- Checks out an existing branch (current flag moves)
- Throws when branch doesn't exist
- Throws when checkout would overwrite uncommitted changes (dirty working tree)

**4. createGitBranch**

- Creates a new branch (appears in listGitBranches)
- Throws when branch already exists

**5. createGitWorktree + removeGitWorktree**

- Creates a worktree directory at the expected path
- Worktree has the correct branch checked out
- Throws when branch is already checked out in another worktree
- removeGitWorktree cleans up the worktree

**6. Full flow: local branch checkout**

- init → commit → create branch → checkout → verify current

**7. Full flow: worktree creation from selected branch**

- init → commit → create branch → create worktree → verify worktree dir exists and has correct branch

**8. Full flow: thread switching simulation**

- init → commit → create branch-a, branch-b → checkout a → checkout b → checkout a → verify current matches

**9. Full flow: checkout conflict**

- init → commit → create branch → modify file (unstaged) → checkout other branch → expect error

## Verification

```bash
# Run the git integration tests
cd apps/desktop && bun run test

# Or just the git test file
npx vitest run apps/desktop/src/git.test.ts
```
