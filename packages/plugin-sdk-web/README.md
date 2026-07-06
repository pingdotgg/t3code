# @t3tools/plugin-sdk-web

> **Import `effect` from the barrel, not subpaths.** `import { Effect, Schema } from "effect"` ✅ —
> `import * as Effect from "effect/Effect"` ❌ does not resolve in a plugin web bundle. The host
> import map enumerates bare specifiers only. See [Importing `effect`](#importing-effect).

Thin host-surface barrel for plugin web bundles. Plugin builds should treat these runtime modules
as externals and let the host import map resolve them at runtime:

- `react`
- `react-dom`
- `react-dom/client`
- `react/jsx-runtime`
- `react/jsx-dev-runtime`
- `@effect/atom-react`
- `effect`
- `@t3tools/contracts`
- `@t3tools/plugin-sdk-web`

The `pluginSdkWebExternalDependencies` / `isPluginSdkWebExternal` exports cover exactly this list
(subpaths included) and can be passed straight to Rollup's `external` in a plugin build.

## Package shape: a compile-time surface, not a standalone build

This package is deliberately **virtual**: `exports` points straight at `src/index.ts`, and the
barrel re-exports live host modules from `apps/web/src` by relative path. It is never built or
published on its own — it typechecks and tests through the workspace and resolves through the host
app's Vite module graph, so `@t3tools/plugin-sdk-web` _is_ the host's own component/state modules
(the same instances the import map serves to plugins as `/plugin-host/*.js` singletons at
runtime). That is also why plugin builds must externalize it: bundling it would inline host app
internals and duplicate React/atom/contracts state that has to stay singleton.

## Importing `effect`

The host import map maps the **bare `effect` specifier only** — not its subpaths. Import effect
modules from the barrel:

```ts
import { Effect, Stream, Option } from "effect"; // ✅ resolves via the host import map
```

Do **not** import effect subpaths in a plugin web bundle:

```ts
import * as Effect from "effect/Effect"; // ❌ not in the import map — fails to resolve in the browser
```

(This differs from server plugins, where a Node resolve hook handles subpaths. Web plugins rely on
the native browser import map, which enumerates the bare specifier.)

## Tailwind

Tailwind v4 utilities are emitted by scanning the host build. A separately-built plugin cannot
assume arbitrary Tailwind utility classes will exist in the host CSS. Use host CSS variables such
as `--background`, `--color-*`, and `.dark`, use the exported host design-system components, or
ship compiled plugin CSS for plugin-local classes.
