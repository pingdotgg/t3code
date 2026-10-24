# Missing terminal folder fixture

Use only an isolated development server and browser profile. These commands do
not start a server, write SQLite, start an agent turn, or copy credentials.

From the repository root, prepare the disposable repository and Unicode worktree:

```sh
node apps/web/test/fixtures/missing-terminal-folder/seed.mjs prepare
```

In an authenticated development browser, import the fixture using Vite's filesystem
module URL (replace `/absolute/worktree`), then seed from an existing stopped
thread in that environment:

```js
const fixture =
  await import("/@fs/absolute/worktree/apps/web/test/fixtures/missing-terminal-folder/browser.mjs");
await fixture.seed(environmentId, sourceThreadId);
await fixture.reset(environmentId);
await fixture.observeSurfaces();
fixture.freezeWallClock();
```

The returned manifest supplies thread IDs and filesystem paths. Navigate to
`/<environmentId>/<threadId>`. The fixed project ID reuses the original disposable
project; on a fresh sandbox the seed creates it. Reset affects only the three
fixture threads. It removes their terminal layout and closes its recorded sessions
with history deletion before the next run. Do not edit these modules during a
recording: Vite can reload the app.

Rename the folder before opening a fresh terminal, then restore it before creating
a recovery terminal:

```sh
node apps/web/test/fixtures/missing-terminal-folder/seed.mjs missing
node apps/web/test/fixtures/missing-terminal-folder/seed.mjs restore
node apps/web/test/fixtures/missing-terminal-folder/seed.mjs manifest
```

A running shell can survive a directory rename. Use a new terminal ID when proving
the missing-folder failure. Open the drawer, create another terminal with **New
Terminal**, then restore and create another terminal for recovery. Run
`printf 'RECOVERED\n'` in the recovered shell. `fixture.write(environmentId,
terminalId, data)` sends real terminal input through the client command.

`observeSurfaces()` wraps the actual Ghostty create/write/reset/selection/dispose
methods without replacing their behavior. Read `window.__terminalFixtureTrace`
for monotonic timestamps and writes; it does not itself establish when an attach
error arrived. Retain that limitation when classifying cold versus warm evidence.
The fixed Date changes wall time only; apply it after authentication and connection
settle. Reloading restores normal Date and removes observation wrappers.

Capture whole app viewports and real interactions at both revisions with identical
seed, dimensions, theme, fonts, and clock. Keep recordings, stills, traces, narrated
timelines, environment manifests, and difference images outside this repository.
