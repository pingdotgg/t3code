# Snippet Picker QA

Date: 2026-04-16
Branch: `codex/rebuild-feature-rollout`

## Environment

- Desktop dev app launched with local project `/Users/canal/.codex/worktrees/28c4/t3code`
- Computer Use QA executed against `ClayCode (Dev)`
- Targeted browser coverage passed:
  - `bun run test:browser -- -t "renders queued turns and wires row actions" src/components/QueuedFollowUpsPanel.browser.tsx`
  - `bun run test:browser -- -t "saves a queued follow-up into the snippet picker" src/components/ChatView.browser.tsx`

## Manual QA

### Scenario 1: Queue panel can save a queued follow-up as a snippet

1. Added the local `t3code` project inside the desktop app.
2. Started a real thread and sent a message so the agent was actively working.
3. Typed a second prompt while the first turn was still running.
4. Clicked **Queue** and verified the queued follow-up panel appeared.
5. Verified the queued row exposed the new **Save queued follow-up as snippet** action.
6. Clicked that action and observed the `Saved to snippets` toast.

Result: pass

### Scenario 2: Saved queued follow-up appears in the snippet picker immediately

1. With the queued follow-up still visible, opened the snippet picker from the composer controls.
2. Verified the newly saved snippet appeared at the top of the list with the queued follow-up text.
3. Verified the picker still included the built-in snippets below it.

Result: pass

## Observations

- The queued-follow-up bookmark flow is now back in parity with the earlier implementation.
- Saving from the queue uses the same saved-snippet library as the composer picker, so the newly created snippet is visible immediately without a refresh.
