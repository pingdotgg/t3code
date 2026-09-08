# fixtures/monorepo-workspace

Mirrors `fixtures/monorepo-workspace`: a two-directory
monorepo where the app's source imports a sibling `lib/` directory across
the package boundary.

```
monorepo-workspace/
  app/                 ← the Vite project root
    vite.config.ts     ← client entry pinned to src/client.ts (no index.html)
    src/server.ts      ← imports ../../lib/src/greeting.ts
    src/client.ts      ← imports ../../lib/src/greeting.ts
  lib/                 ← sibling directory with its own package.json + src
    package.json       ← makes lib/ a "workspace root" for the collector
    src/greeting.ts
```

`lib/` is deliberately NOT a package-manager workspace member — the app
reaches it by relative import, which is exactly the cross-boundary module
id the build-output collector classifies as an external workspace.

Consumed by `WorkspaceMemo.test.ts`, which exercises the input-hash memo
machinery (`hashViteInput` + the vite source's `hash()` slots): a
workspace list containing `../lib` must make edits under `lib/` bust the
memo, while untouched recomputes stay memoized. The ct sibling fixture
pins the prerequisite (the collector reports `lib/` in
`externalWorkspaces`); this fixture pins the consumer (the memo layer
folds the reported workspace into `hash.input`).
