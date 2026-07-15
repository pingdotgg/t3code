/**
 * Host UI, hooks and atom plumbing, re-exported to plugin web bundles.
 *
 * MONOREPO-ONLY, and that is the point of this file existing separately.
 *
 * Everything below re-exports a LIVE host module out of `apps/web`. That works at
 * runtime — a plugin externalises `@t3tools/plugin-sdk-web`, so the import map hands
 * it the host's own singletons rather than a second copy of React, the atom registry
 * or the settings store. But it means a consumer OUTSIDE this repo typechecks the
 * host's entire UI library, through the host's own `~/*` alias, against the host's
 * copy of `@types/react` — a different physical package from theirs. Same version,
 * different identity, ~60 structural errors about nothing.
 *
 * So this entry is not consumable outside the monorepo, and the SDK proper (`.`) is.
 * A plugin that does not need the host's components — most of them — can be written,
 * typechecked and shipped from anywhere. One that wants them has to live here, until
 * the curated set moves into a package both this and `apps/web` depend on.
 *
 * That refactor is also the moment to CURATE. Every component re-exported here is a
 * public plugin API: renaming a prop on `alert.tsx` is a breaking change for every
 * plugin in the wild. There are ~40 of them, and nobody chose that number.
 *
 * @module plugin-sdk-web/ui
 */
export { createPluginAtoms, getAppAtomRegistry, getConnectionAtomRuntime } from "./atomAdapter";
export {
  HydrationBoundary,
  RegistryContext,
  RegistryProvider,
  TypeId,
  make,
  scheduleTask,
  useAtom,
  useAtomInitialValues,
  useAtomMount,
  useAtomRef,
  useAtomRefProp,
  useAtomRefPropValue,
  useAtomRefresh,
  useAtomSet,
  useAtomSubscribe,
  useAtomSuspense,
  useAtomValue,
} from "../../../apps/web/src/plugins/pluginSdkAtomReact.ts";
export {
  AsyncResult,
  Atom,
  AtomRegistry,
} from "../../../apps/web/src/plugins/pluginSdkAtomReact.ts";

export * from "../../../apps/web/src/components/ui/alert.tsx";
export * from "../../../apps/web/src/components/ui/alert-dialog.tsx";
export * from "../../../apps/web/src/components/ui/badge.tsx";
export * from "../../../apps/web/src/components/ui/button.tsx";
export * from "../../../apps/web/src/components/ui/card.tsx";
export * from "../../../apps/web/src/components/ui/checkbox.tsx";
export * from "../../../apps/web/src/components/ui/command.tsx";
export * from "../../../apps/web/src/components/ui/dialog.tsx";
export * from "../../../apps/web/src/components/ui/empty.tsx";
export * from "../../../apps/web/src/components/ui/field.tsx";
export * from "../../../apps/web/src/components/ui/input.tsx";
export * from "../../../apps/web/src/components/ui/label.tsx";
export * from "../../../apps/web/src/components/ui/menu.tsx";
export * from "../../../apps/web/src/components/ui/popover.tsx";
export * from "../../../apps/web/src/components/ui/scroll-area.tsx";
export * from "../../../apps/web/src/components/ui/select.tsx";
export * from "../../../apps/web/src/components/ui/separator.tsx";
export * from "../../../apps/web/src/components/ui/sheet.tsx";
export * from "../../../apps/web/src/components/ui/sidebar.tsx";
export * from "../../../apps/web/src/components/ui/spinner.tsx";
export * from "../../../apps/web/src/components/ui/switch.tsx";
export * from "../../../apps/web/src/components/ui/textarea.tsx";
export * from "../../../apps/web/src/components/ui/toast.tsx";
export * from "../../../apps/web/src/components/ui/tooltip.tsx";
export { default as ChatMarkdown } from "../../../apps/web/src/components/ChatMarkdown.tsx";
export { ProviderModelPicker } from "../../../apps/web/src/components/chat/ProviderModelPicker.tsx";
export {
  TraitsMenuContent,
  TraitsPicker,
  shouldRenderTraitsControls,
} from "../../../apps/web/src/components/chat/TraitsPicker.tsx";
export { useAtomCommand } from "../../../apps/web/src/state/use-atom-command.ts";
export { useAtomQueryRunner } from "../../../apps/web/src/state/use-atom-query-runner.ts";
// Environment/project context so a plugin surface can resolve the active
// project(s) for the environment it renders in (e.g. the board list needs a real
// projectId — the environment id is NOT a project id).
export { useEnvironmentProjectRefs } from "../../../apps/web/src/state/entities.ts";
// Schema-error formatting from @t3tools/shared. Re-exported through the SDK
// singleton so plugins don't bundle @t3tools/shared/schemaJson (which imports
// effect/* subpaths the browser import map can't resolve).
export { formatSchemaError } from "@t3tools/shared/schemaJson";

// Host UI/util surface available to plugin web bundles. These are re-exports of
// live host modules — a separately-built plugin externalises
// `@t3tools/plugin-sdk-web`, so at runtime it shares the host's
// singleton instances (React, atoms, settings, provider state) through the import
// map rather than bundling its own copies.
export { cn, randomUUID } from "../../../apps/web/src/lib/utils.ts";
export { useTheme } from "../../../apps/web/src/hooks/useTheme.ts";
export { usePrimarySettings } from "../../../apps/web/src/hooks/useSettings.ts";
export { formatDuration } from "../../../apps/web/src/session-logic.ts";
export { primaryServerProvidersAtom } from "../../../apps/web/src/state/server.ts";
export {
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../../apps/web/src/providerInstances.ts";
export {
  getAppModelOptionsForInstance,
  type AppModelOption,
} from "../../../apps/web/src/modelSelection.ts";
// Diff-rendering stack (ticket diffs). `FileDiff` comes from `@pierre/diffs/react`
// (the host already depends on it for chat diffs) and relies on the host's
// worker-pool context provider being mounted around the app.
export { DiffStatLabel } from "../../../apps/web/src/components/chat/DiffStatLabel.tsx";
export {
  buildFileDiffRenderKey,
  getRenderablePatch,
  resolveDiffThemeName,
  resolveFileDiffPath,
  type RenderablePatch,
  type DiffThemeName,
} from "../../../apps/web/src/lib/diffRendering.ts";
export { FileDiff } from "@pierre/diffs/react";
