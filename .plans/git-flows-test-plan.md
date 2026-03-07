# Git Flows Test Plan

## Overview

Add tests for git branch/worktree flows. Two files:

1. **Extend** `apps/renderer/src/store.test.ts` — reducer tests for `SET_THREAD_BRANCH`
2. **Create** `apps/renderer/src/git-flows.test.ts` — flow logic tests

All tests are pure Vitest unit tests (no React rendering). They test the reducer directly and simulate handler logic via sequential reducer dispatches + mocked API calls.

## File 1: `apps/renderer/src/store.test.ts` (extend)

Add `describe("SET_THREAD_BRANCH reducer")` with 6 tests:

- Sets branch + worktreePath atomically
- Clears both to null
- Updates branch while preserving worktreePath
- Does not affect other threads (multi-thread state)
- No-op for nonexistent thread id
- Does not mutate messages, error, or session fields

Uses existing `makeThread`, `makeState` factories.

## File 2: `apps/renderer/src/git-flows.test.ts` (new)

### Factories

- `makeThread()`, `makeState()`, `makeSession()` — same pattern as store.test.ts
- `makeBranch()` — creates `GitBranch` objects
- `makeMessage()` — creates `ChatMessage` objects
- `makeGitApi()` — returns `{ checkout, createWorktree, createBranch, listBranches }` with `vi.fn()` mocks

### Test groups (~30 tests total)

**1. Local branch checkout flow** (2 tests)

- Successful checkout → SET_THREAD_BRANCH updates branch
- Checkout failure → SET_ERROR, branch unchanged

**2. Thread branch conflict on send** (3 tests)

- Two threads maintain independent branch state after SET_ACTIVE_THREAD
- Branch state preserved through multiple thread switches + updates
- Checkout failure on thread switch sets error only on target thread

**3. Worktree creation on send** (5 tests)

- First message in worktree mode → createWorktree → SET_THREAD_BRANCH with worktreePath
- No worktree when messages already exist
- No worktree in local envMode
- No worktree when worktreePath already set
- createWorktree failure → SET_ERROR, send aborted, no messages pushed

**4. Env mode locking** (4 tests)

- envLocked=false when no messages
- envLocked=true with messages
- Transitions false→true after PUSH_USER_MESSAGE
- Remains true after SET_ERROR and UPDATE_SESSION

**5. Auto-fill current branch** (3 tests)

- Dispatches SET_THREAD_BRANCH when thread has no branch and current branch exists
- Does not overwrite existing branch
- No-op when no branch is marked current

**6. Default branch detection** (2 tests)

- isDefault flag on branch objects
- current and isDefault can be on different branches

**7. Branch creation + checkout** (3 tests)

- Successful create + checkout updates branch
- createBranch failure → error, branch unchanged
- checkout failure after successful create → error, branch unchanged

**8. Session CWD resolution** (3 tests)

- Uses worktreePath when available
- cwdOverride takes precedence over worktreePath
- Falls back to project cwd when no worktree

**9. Error handling patterns** (4 tests)

- SET_ERROR sets error on correct thread
- SET_ERROR with null clears error
- Error on one thread doesn't affect others
- Error cleared before successful branch operations

## Verification

```bash
# Run all renderer tests
cd apps/renderer && bun run test

# Run just the new test file
npx vitest run apps/renderer/src/git-flows.test.ts

# Run just the store tests
npx vitest run apps/renderer/src/store.test.ts
```
