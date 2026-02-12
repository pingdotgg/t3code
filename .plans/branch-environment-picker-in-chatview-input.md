# Branch/Environment Picker in ChatView Input

## Summary

Add a secondary toolbar below the ChatView input area (similar to Codex UI) that lets users select the target branch and environment mode (Local vs New worktree) before sending their first message.

## UX

- A toolbar appears **below** the input form (always visible when it's a git repo)
- Two controls:
  1. **Environment mode** (left side): toggles between "Local" and "New worktree" — **locked after first message** (no longer clickable, just shows current mode as label)
  2. **Branch picker** (right side): dropdown showing local branches — **always changeable**, even after messages are sent
- If not a git repo, the toolbar is hidden entirely (thread uses project cwd as-is)

## Changes

### 0. Install `@tanstack/react-query` in `apps/renderer`

Add dependency + wrap app in `QueryClientProvider`.

### 1. `apps/renderer/src/store.ts` — MODIFY

Add a new action to the reducer:

```ts
| { type: "SET_THREAD_BRANCH"; threadId: string; branch: string | null; worktreePath: string | null }
```

Reducer case updates `branch` and `worktreePath` on the thread.

### 2. `apps/renderer/src/components/ChatView.tsx` — MODIFY

**Fetch branches** via `useQuery`:

```ts
const branchQuery = useQuery({
  queryKey: ["git-branches", activeProject?.cwd],
  queryFn: () => api.git.listBranches({ cwd: activeProject!.cwd }),
  enabled: !!activeProject,
});
```

**Local state:**

- `envMode: "local" | "worktree"` — environment mode (local component state)

**UI:** Below the `<form>`, render a toolbar bar (hidden if `!branchQuery.data?.isRepo`):

- Left side: env mode button ("Local" / "New worktree") — disabled after first message (locked in)
- Right side: branch dropdown from `branchQuery.data.branches`
- Both styled like existing model picker (small text, chevron, dropdown menus)

**Behavior:**

- Branch picker is always active — changing branch dispatches `SET_THREAD_BRANCH` immediately
- Env mode is only clickable when `activeThread.messages.length === 0`. After first message, it becomes a static label showing the locked-in mode
- On first send (`onSend`): if `envMode === "worktree"` and a branch is selected, call `api.git.createWorktree` before starting the session, then dispatch `SET_THREAD_BRANCH` with the worktreePath
- `ensureSession` already uses `activeThread.worktreePath ?? activeProject.cwd`

### Files to modify

1. `apps/renderer/package.json` — add `@tanstack/react-query`
2. `apps/renderer/src/main.tsx` (or App entry) — wrap in `QueryClientProvider`
3. `apps/renderer/src/store.ts` — add `SET_THREAD_BRANCH` action
4. `apps/renderer/src/components/ChatView.tsx` — branch/env picker UI with `useQuery`

## Verification

1. `turbo build` — compiles
2. Create a new thread → branch bar appears below input with "Local" + current branch
3. Change branch in dropdown → branch updates on thread
4. Toggle "New worktree" → send message → worktree created, session uses worktree cwd
5. After first message: env mode label locks to "Worktree" (not clickable), branch picker still works
6. Non-git project → no branch bar shown
