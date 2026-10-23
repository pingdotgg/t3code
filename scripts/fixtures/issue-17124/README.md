# Composer list evidence fixtures

Use only with the isolated development app for this worktree. `seed.js` runs
inside T3's Browser panel via `preview_evaluate`; it imports the production
document builder and serializer and dispatches through the real EditorView.
It does not synthesize editor DOM or keyboard events.

```js
const worktreePath = "/absolute/path/to/your/worktree";
window.fixture = await import(`/@fs${worktreePath}/scripts/fixtures/issue-17124/seed.js`);
await fixture.seed(fixture.fixtures.A[0]);
// Use preview_press for Tab, X, Shift+Enter, and Backspace.
await fixture.observe();
```

Select rich/plain with the app's `composerRichTextEnabled` preference before
opening the fixture thread. `|` denotes the requested caret; rich structural
marker prefixes normalize to the reachable content position. Seed returns both
requested and canonical text so a capture can report normalization.

`installRpc(environmentId)` binds normal guarded app commands to the isolated
environment. `createFixtureThread(rpc, projectId, worktreePath)` creates an empty
synthetic thread in the supplied absolute worktree path. Use the isolated server's
worktree path for `worktreePath` in both the module import and thread creation.
`stageRenderedFixture(rpc, threadId)` takes the current
serialized composer text, dispatches it with `defer_start`, then interrupts the
prepared run with its queue held. Never release the prepared run: this path is
for inspecting the real message renderer without starting a provider. Use a
fresh fixture thread for each sequence because this helper expects run ordinal 1.

Record A→E in order, resetting each fixture. C uses three Shift+Enter operations,
each followed by X and deletion of only X. D's third fixture tests an editable
numeric prefix in plain mode and the normalized content caret in rich mode.
Keep recordings, serialized observations, screenshots, and pixel diffs outside
the repository. Collapse the sidebar after navigation and verify the actual
theme, viewport, fonts, and DPR before recording.
