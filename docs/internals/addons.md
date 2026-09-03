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
Every control supplies a stable `contributionId`. The host combines it with the
manifest ID, so one addon may safely render multiple controls.

Submission payloads contain an addon-owned revision and opaque value. The host
snapshots them before dispatch and commits that exact snapshot only after T3
accepts the thread's first turn. Successful-send cleanup receives the submitted
revision and must clear atomically only when the staged value still has that
revision. This preserves edits made while uploads or turn creation are in
flight. Draft discard invokes every cleanup hook; it supplies a null expected
revision when no readable payload exists so invalid or partially staged state
is removed too.

Lifecycle callbacks may be synchronous or asynchronous. The host isolates
read, commit, and cleanup failures per addon so one broken callback cannot
strand the composer or prevent later addons from running. Blocking validation
is enforced by the common send path, including sends initiated outside the
composer form such as preview annotations.

Hooks must remain deterministic for the lifetime of the compiled build. Addons
must not change their hook topology at runtime.

## Sidebar contract

A sidebar addon returns contributions keyed by environment-scoped T3 thread
references. Every contribution also has a stable `contributionId`. It may:

- render metadata in full cards and compact rows;
- add an addon-owned card class;
- mark a row as a parent, child, or standalone addon row;
- attach a child to an explicit parent thread ID.

Core composes UI when multiple addons annotate the same thread. It accepts a
child relationship only when all valid claims agree on one present,
environment-scoped parent. Missing, conflicting, cyclic, or nested parentage
leaves the affected row top-level. The normalized group order drives rendering,
keyboard navigation, and range selection together. Core never infers
relationships from titles, prompts, or addon display text.

## Boundary

Addons may consume public T3 client state and their own services. They should
not patch core components, create a second thread list, or open a separate
mutation socket. New surfaces belong in a narrow addon contract first; product
implementations belong under `addons/bundled/`.
