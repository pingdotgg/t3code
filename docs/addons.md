# Web addons

T3 Code supports trusted, build-time web addons. Addons contribute UI and
submission behavior through narrow contracts while the core application keeps
ownership of layout, thread creation, persistence, and navigation.

This is intentionally not a runtime JavaScript plugin loader. Shipping an addon
means compiling and signing it with the application, so an installed build does
not execute code downloaded from an arbitrary directory.

## Bundle an addon

Create `apps/web/src/addons/bundled/<addon-id>/index.ts` with a default export:

```ts
import type { WebAddon } from "../../registry";

const addon = {
  id: "example-addon",
  composer: exampleComposerAddon,
  sidebar: exampleSidebarAddon,
} satisfies WebAddon;

export default addon;
```

The build discovers these manifests in lexical path order. IDs must be unique
kebab-case values. An invalid or duplicate ID fails immediately instead of
silently shadowing another addon.

## Composer contract

A composer addon may contribute controls, report a blocking validation issue,
and attach an opaque payload to the first successful submission of a new chat.
The payload is read before dispatch and committed only after T3 accepts the
thread's first turn, avoiding orphaned addon state when creation fails.

Hooks must remain deterministic for the lifetime of the compiled build. Addons
must not change their hook topology at runtime.

## Sidebar contract

A sidebar addon returns contributions keyed by existing T3 thread IDs. It may:

- render metadata in full cards and compact rows;
- add an addon-owned card class;
- mark a row as a parent, child, or standalone addon row;
- attach a child to an explicit parent thread ID.

Core renders only relationships whose parent and child threads both exist.
Missing parents leave the child top-level. Core never infers relationships from
titles, prompts, or addon display text.

## Boundary

Addons may consume public T3 client state and their own services. They should
not patch core components, create a second thread list, or open a separate
mutation socket. New surfaces belong in a narrow addon contract first; product
implementations belong under `addons/bundled/`.
