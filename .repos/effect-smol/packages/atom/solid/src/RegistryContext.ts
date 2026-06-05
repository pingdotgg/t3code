/**
 * The `RegistryContext` module provides the Solid context used by Effect Atom
 * hooks to share an `AtomRegistry` across an owner tree. The registry owns atom
 * state, scheduling, and idle cleanup, so Solid components that read or write
 * atoms coordinate through the same runtime instead of creating isolated
 * registries.
 *
 * **Common tasks**
 *
 * - Use {@link RegistryProvider} to scope atom state to a Solid subtree
 * - Seed atoms for tests, examples, or server-provided data with `initialValues`
 * - Override scheduling or idle timing for custom rendering environments
 * - Read {@link RegistryContext} when integrating lower-level atom APIs
 *
 * **Gotchas**
 *
 * - The provider creates a registry for the current Solid owner and disposes it
 *   with `onCleanup`
 * - `initialValues` are applied when the provider creates the registry, not as
 *   reactive updates after creation
 * - Overriding `scheduleTask` changes when atom work is flushed, so it should
 *   return a cancellation function that is safe to call during Solid cleanup
 *
 * @since 4.0.0
 */
import type * as Atom from "effect/unstable/reactivity/Atom"
import * as AtomRegistry from "effect/unstable/reactivity/AtomRegistry"
import type { JSX } from "solid-js"
import { createComponent, createContext, onCleanup } from "solid-js"

/**
 * Provides a Solid context that carries the `AtomRegistry` used by atom hooks in the
 * current owner tree.
 *
 * **When to use**
 *
 * Use when integrating lower-level Solid atom APIs that need direct access to,
 * or direct provisioning of, the `AtomRegistry` for the current owner tree.
 *
 * **Details**
 *
 * When no provider is present, the context uses a standalone default registry.
 *
 * @see {@link RegistryProvider} for creating and providing a registry for a Solid subtree
 *
 * @category context
 * @since 4.0.0
 */
export const RegistryContext = createContext<AtomRegistry.AtomRegistry>(AtomRegistry.make())

/**
 * Creates an `AtomRegistry` for a Solid subtree, optionally seeding initial atom
 * values and scheduler settings, and disposes the registry when the owner is
 * cleaned up.
 *
 * **When to use**
 *
 * Use to scope atom state, scheduling, and cleanup to a Solid subtree.
 *
 * **Details**
 *
 * The provider creates an `AtomRegistry` with `AtomRegistry.make`, forwards
 * `initialValues`, `scheduleTask`, `timeoutResolution`, and
 * `defaultIdleTTL`, and supplies the registry through `RegistryContext`.
 *
 * **Gotchas**
 *
 * Provider options are consumed when the registry is created; they are not
 * reactive updates. A custom `scheduleTask` should return a cancellation
 * function that is safe to call during Solid cleanup.
 *
 * @see {@link RegistryContext} for the context supplied by this provider
 *
 * @category context
 * @since 4.0.0
 */
export const RegistryProvider = (options: {
  readonly children?: JSX.Element | undefined
  readonly initialValues?: Iterable<readonly [Atom.Atom<any>, any]> | undefined
  readonly scheduleTask?: ((f: () => void) => () => void) | undefined
  readonly timeoutResolution?: number | undefined
  readonly defaultIdleTTL?: number | undefined
}) => {
  const registry = AtomRegistry.make({
    scheduleTask: options.scheduleTask,
    initialValues: options.initialValues,
    timeoutResolution: options.timeoutResolution,
    defaultIdleTTL: options.defaultIdleTTL ?? 400
  })
  onCleanup(() => registry.dispose())
  return createComponent(RegistryContext.Provider, {
    value: registry,
    get children() {
      return options.children
    }
  })
}
