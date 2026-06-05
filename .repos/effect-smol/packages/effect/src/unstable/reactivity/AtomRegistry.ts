/**
 * The `AtomRegistry` module provides the runtime cache for unstable reactivity
 * atoms. A registry owns the node graph for a group of atoms, stores current
 * values, records parent and child dependencies while atoms are read, and
 * coordinates writes, refreshes, subscriptions, stream conversions, and node
 * disposal.
 *
 * Use a separate registry for each UI root, request, test, route boundary, or
 * other lifetime that needs isolated atom state. The same atom object can have
 * different cached values in different registries, while serializable atoms use
 * their stable serialization key so preloaded values can hydrate a node before
 * the first read.
 *
 * **Mental model**
 *
 * - Reading an atom creates or reuses a registry node, evaluates the atom when
 *   its value is missing or stale, and records any nested atom reads as
 *   dependencies.
 * - Writing a writable atom updates its node through the atom's write function,
 *   invalidates dependent nodes, and notifies listeners after batching settles.
 * - Subscriptions and scoped {@link mount} calls keep nodes alive. When the last
 *   listener and dependent child disappear, non-`keepAlive` atoms can be
 *   removed immediately or after their idle TTL.
 * - Effects and streams started by atoms run with the registry scheduler and
 *   are finalized when the node is rebuilt, removed, reset, or disposed.
 * - Disposing a registry clears its nodes and makes later atom access an error.
 *
 * **Common tasks**
 *
 * - Create a registry directly with {@link make}, or provide one to Effect
 *   programs with {@link layer} or {@link layerOptions}.
 * - Read and write atom state with the registry instance methods `get`, `set`,
 *   `modify`, `update`, and `refresh`.
 * - Keep an atom alive for an Effect scope with {@link mount}; subscribe with
 *   `subscribe` when integrating with callback-based UI code.
 * - Convert observed atom values with {@link toStream} and
 *   {@link toStreamResult}, or wait for an `AsyncResult` atom with
 *   {@link getResult}.
 * - Preload encoded serializable state with `setSerializable` before the
 *   matching atom is read.
 *
 * **Quickstart**
 *
 * **Example** (Isolated atom state)
 *
 * ```ts
 * import { Atom, AtomRegistry } from "effect/unstable/reactivity"
 *
 * const count = Atom.make(0)
 * const doubled = Atom.make((get) => get(count) * 2)
 *
 * const registry = AtomRegistry.make()
 *
 * registry.set(count, 21)
 * registry.get(doubled)
 * // 42
 * ```
 *
 * **Gotchas**
 *
 * - Atom identity matters. Creating a new atom object creates a different node
 *   unless the atom is serializable and uses the same serialization key.
 * - Unobserved atoms without `keepAlive` can be removed, so later reads may
 *   rebuild derived values, restart effects or streams, and rerun finalizers.
 * - `subscribe` and the instance `mount` method return release callbacks; call
 *   them when the external consumer is done. The exported {@link mount} helper
 *   ties that release to an Effect scope.
 * - `reset` and `dispose` remove every node in the registry. Use a new registry
 *   when a whole lifetime should start from empty state.
 *
 * **See also**
 *
 * - {@link Atom.Atom} for defining reactive values read by a registry.
 * - {@link Result.AsyncResult} for asynchronous atom results.
 * - {@link Stream.Stream} for streams produced from observed atom values.
 *
 * @since 4.0.0
 */
import * as Context from "../../Context.ts"
import * as Effect from "../../Effect.ts"
import * as Exit from "../../Exit.ts"
import * as Fiber from "../../Fiber.ts"
import { constVoid, dual } from "../../Function.ts"
import * as Layer from "../../Layer.ts"
import * as Option from "../../Option.ts"
import { hasProperty } from "../../Predicate.ts"
import * as Queue from "../../Queue.ts"
import type { Scheduler, SchedulerDispatcher } from "../../Scheduler.ts"
import { MixedScheduler } from "../../Scheduler.ts"
import * as Scope from "../../Scope.ts"
import * as Stream from "../../Stream.ts"
import * as Result from "./AsyncResult.ts"
import type * as Atom from "./Atom.ts"

/**
 * The literal type used to identify `AtomRegistry` services and values.
 *
 * @category type IDs
 * @since 4.0.0
 */
export type TypeId = "~effect/reactivity/AtomRegistry"

/**
 * The runtime type id used to identify `AtomRegistry` services and values.
 *
 * @category type IDs
 * @since 4.0.0
 */
export const TypeId: TypeId = "~effect/reactivity/AtomRegistry"

/**
 * Returns `true` when the value has the `AtomRegistry` type id.
 *
 * @category guards
 * @since 4.0.0
 */
export const isAtomRegistry = (u: unknown): u is AtomRegistry => hasProperty(u, TypeId)

/**
 * The runtime registry that stores atom nodes and coordinates reads, writes,
 * refreshes, subscriptions, and disposal.
 *
 * **Details**
 *
 * It also manages scheduler configuration, serializable preloaded values, and node
 * addition/removal callbacks.
 *
 * @category models
 * @since 4.0.0
 */
export interface AtomRegistry {
  readonly [TypeId]: TypeId
  readonly scheduler: Scheduler
  readonly schedulerAsync: Scheduler
  readonly getNodes: () => ReadonlyMap<Atom.Atom<any> | string, Node<any>>
  readonly get: <A>(atom: Atom.Atom<A>) => A
  readonly mount: <A>(atom: Atom.Atom<A>) => () => void
  readonly refresh: <A>(atom: Atom.Atom<A>) => void
  readonly set: <R, W>(atom: Atom.Writable<R, W>, value: W) => void
  readonly setSerializable: (key: string, encoded: unknown) => void
  readonly modify: <R, W, A>(atom: Atom.Writable<R, W>, f: (_: R) => [returnValue: A, nextValue: W]) => A
  readonly update: <R, W>(atom: Atom.Writable<R, W>, f: (_: R) => W) => void
  readonly subscribe: <A>(atom: Atom.Atom<A>, f: (_: A) => void, options?: {
    readonly immediate?: boolean
  }) => () => void
  readonly reset: () => void
  readonly dispose: () => void
  onNodeAdded?: ((node: Node<any>) => void) | undefined
  onNodeRemoved?: ((node: Node<any>) => void) | undefined
}

/**
 * A registry node for a single atom.
 *
 * **Details**
 *
 * Nodes expose the current value, parent and child dependency links, listener set,
 * and current lifecycle state.
 *
 * @category models
 * @since 4.0.0
 */
export interface Node<A> {
  readonly atom: Atom.Atom<A>
  readonly value: () => A
  parents: Array<Node<any>>
  children: Array<Node<any>>
  listeners: Set<() => void>
  currentState(): "uninitialized" | "stale" | "valid" | "removed"
}

/**
 * Creates an `AtomRegistry`.
 *
 * **Details**
 *
 * Options can preload initial atom values, provide a custom task scheduler,
 * configure timeout bucket resolution, and set a default idle time-to-live for
 * unused atoms.
 *
 * @category constructors
 * @since 4.0.0
 */
export const make = (
  options?: {
    readonly initialValues?: Iterable<readonly [Atom.Atom<any>, any]> | undefined
    readonly scheduleTask?: ((f: () => void) => () => void) | undefined
    readonly timeoutResolution?: number | undefined
    readonly defaultIdleTTL?: number | undefined
  } | undefined
): AtomRegistry =>
  new RegistryImpl(
    options?.initialValues,
    options?.scheduleTask,
    options?.timeoutResolution,
    options?.defaultIdleTTL
  )

/**
 * Service tag for the active atom runtime cache.
 *
 * **When to use**
 *
 * Use to access or provide the registry that stores atom values,
 * dependencies, subscriptions, and disposal state for a reactive lifetime.
 *
 * @category tags
 * @since 4.0.0
 */
export const AtomRegistry = Context.Service<AtomRegistry>(TypeId)

/**
 * Creates a layer that provides an `AtomRegistry` configured with the supplied
 * options.
 *
 * **Details**
 *
 * The registry is disposed when the layer scope is finalized.
 *
 * @category layers
 * @since 4.0.0
 */
export const layerOptions = (options?: {
  readonly initialValues?: Iterable<readonly [Atom.Atom<any>, any]> | undefined
  readonly scheduleTask?: ((f: () => void) => () => void) | undefined
  readonly timeoutResolution?: number | undefined
  readonly defaultIdleTTL?: number | undefined
}): Layer.Layer<AtomRegistry> =>
  Layer.effect(
    AtomRegistry,
    Effect.gen(function*() {
      const scope = yield* Effect.scope
      const registry = make({
        ...options,
        scheduleTask: options?.scheduleTask
      })
      yield* Scope.addFinalizer(scope, Effect.sync(() => registry.dispose()))
      return registry
    })
  )

/**
 * The default layer that provides a fresh `AtomRegistry`.
 *
 * @category layers
 * @since 4.0.0
 */
export const layer: Layer.Layer<AtomRegistry> = layerOptions()

// -----------------------------------------------------------------------------
// conversions
// -----------------------------------------------------------------------------

/**
 * Converts an atom in this registry into a stream.
 *
 * **Details**
 *
 * The stream emits the current value immediately, emits subsequent changes, and
 * unsubscribes from the registry when the stream scope closes.
 *
 * @category converting
 * @since 4.0.0
 */
export const toStream: {
  <A>(atom: Atom.Atom<A>): (self: AtomRegistry) => Stream.Stream<A>
  <A>(self: AtomRegistry, atom: Atom.Atom<A>): Stream.Stream<A>
} = dual(
  2,
  <A>(self: AtomRegistry, atom: Atom.Atom<A>) =>
    Stream.callback<A>((queue) =>
      Effect.suspend(() => {
        const fiber = Fiber.getCurrent()!
        const scope = Context.getUnsafe(fiber.context, Scope.Scope)
        const cancel = self.subscribe(atom, (value) => Queue.offerUnsafe(queue, value), {
          immediate: true
        })
        return Scope.addFinalizer(scope, Effect.sync(cancel))
      })
    )
)

/**
 * Converts an `AsyncResult` atom in this registry into a stream of successful
 * values.
 *
 * **Details**
 *
 * Initial results are skipped, failures fail the stream with their cause, and
 * duplicate stream values are dropped with `Stream.changes`.
 *
 * @category converting
 * @since 4.0.0
 */
export const toStreamResult: {
  <A, E>(atom: Atom.Atom<Result.AsyncResult<A, E>>): (self: AtomRegistry) => Stream.Stream<A, E>
  <A, E>(self: AtomRegistry, atom: Atom.Atom<Result.AsyncResult<A, E>>): Stream.Stream<A, E>
} = dual(
  2,
  <A, E>(self: AtomRegistry, atom: Atom.Atom<Result.AsyncResult<A, E>>): Stream.Stream<A, E> =>
    toStream(self, atom).pipe(
      Stream.filter(Result.isNotInitial),
      Stream.mapEffect((result) =>
        result._tag === "Success" ? Effect.succeed(result.value) : Effect.failCause(result.cause)
      ),
      Stream.changes
    )
)

/**
 * Reads an `AsyncResult` atom from this registry as an effect.
 *
 * **Details**
 *
 * The effect waits for the result to leave `Initial`, and also waits through
 * waiting results when `suspendOnWaiting` is enabled.
 *
 * @category converting
 * @since 4.0.0
 */
export const getResult: {
  <A, E>(atom: Atom.Atom<Result.AsyncResult<A, E>>, options?: {
    readonly suspendOnWaiting?: boolean | undefined
  }): (self: AtomRegistry) => Effect.Effect<A, E>
  <A, E>(self: AtomRegistry, atom: Atom.Atom<Result.AsyncResult<A, E>>, options?: {
    readonly suspendOnWaiting?: boolean | undefined
  }): Effect.Effect<A, E>
} = dual(
  (args) => isAtomRegistry(args[0]),
  <A, E>(self: AtomRegistry, atom: Atom.Atom<Result.AsyncResult<A, E>>, options?: {
    readonly suspendOnWaiting?: boolean | undefined
  }): Effect.Effect<A, E> => {
    const suspendOnWaiting = options?.suspendOnWaiting ?? false
    return Effect.callback((resume) => {
      const result = self.get(atom)
      if (result._tag !== "Initial" && !(suspendOnWaiting && result.waiting)) {
        return resume(Result.toExit(result) as any)
      }
      const cancel = self.subscribe(atom, (value) => {
        if (value._tag !== "Initial" && !(suspendOnWaiting && value.waiting)) {
          resume(Result.toExit(value) as any)
          cancel()
        }
      })
      return Effect.sync(cancel)
    })
  }
)

/**
 * Mounts an atom in this registry for the lifetime of the current scope.
 *
 * **Details**
 *
 * The atom is subscribed with a no-op listener and the subscription is released
 * when the scope finalizer runs.
 *
 * @category converting
 * @since 4.0.0
 */
export const mount: {
  <A>(atom: Atom.Atom<A>): (self: AtomRegistry) => Effect.Effect<void, never, Scope.Scope>
  <A>(self: AtomRegistry, atom: Atom.Atom<A>): Effect.Effect<void, never, Scope.Scope>
} = dual(
  2,
  <A>(self: AtomRegistry, atom: Atom.Atom<A>) =>
    Effect.acquireRelease(
      Effect.sync(() => self.mount(atom)),
      (release) => Effect.sync(release)
    )
)

// -----------------------------------------------------------------------------
// internal
// -----------------------------------------------------------------------------

const constImmediate = { immediate: true }

const notifyListener = (listener: () => void): void => {
  listener()
}

const SerializableTypeId: Atom.SerializableTypeId = "~effect-atom/atom/Atom/Serializable"
const atomKey = <A>(atom: Atom.Atom<A>): Atom.Atom<A> | string =>
  SerializableTypeId in atom ? (atom as Atom.Serializable<any>)[SerializableTypeId].key : atom

class RegistryImpl implements AtomRegistry {
  readonly [TypeId]: TypeId
  readonly timeoutResolution: number
  readonly defaultIdleTTL: number | undefined
  readonly scheduler: Scheduler
  readonly schedulerAsync: Scheduler
  readonly dispatcher: SchedulerDispatcher
  onNodeAdded?: ((node: Node<any>) => void) | undefined
  onNodeRemoved?: ((node: Node<any>) => void) | undefined

  constructor(
    initialValues?: Iterable<readonly [Atom.Atom<any>, any]>,
    scheduleTask?: (cb: () => void) => () => void,
    timeoutResolution?: number,
    defaultIdleTTL?: number
  ) {
    this[TypeId] = TypeId
    this.scheduler = new MixedScheduler("sync", scheduleTask)
    this.schedulerAsync = new MixedScheduler("async", scheduleTask)
    this.dispatcher = this.schedulerAsync.makeDispatcher()
    this.defaultIdleTTL = defaultIdleTTL

    if (timeoutResolution === undefined && defaultIdleTTL !== undefined) {
      this.timeoutResolution = Math.round(defaultIdleTTL / 2)
    } else {
      this.timeoutResolution = timeoutResolution ?? 1000
    }
    if (initialValues !== undefined) {
      for (const [atom, value] of initialValues) {
        let target = atom
        while (target.initialValueTarget) {
          target = target.initialValueTarget
        }
        this.ensureNode(target).setInitialValue(value)
      }
    }
  }

  readonly nodes = new Map<Atom.Atom<any> | string, NodeImpl<any>>()
  readonly preloadedSerializable = new Map<string, unknown>()
  readonly timeoutBuckets = new Map<number, readonly [nodes: Set<NodeImpl<any>>, handle: number]>()
  readonly nodeTimeoutBucket = new Map<NodeImpl<any>, number>()
  disposed = false

  getNodes() {
    return this.nodes
  }

  get<A>(atom: Atom.Atom<A>): A {
    return this.ensureNode(atom).value()
  }

  set<R, W>(atom: Atom.Writable<R, W>, value: W): void {
    atom.write(this.ensureNode(atom).writeContext, value)
  }

  setSerializable(key: string, encoded: unknown): void {
    this.preloadedSerializable.set(key, encoded)
  }

  modify<R, W, A>(atom: Atom.Writable<R, W>, f: (_: R) => [returnValue: A, nextValue: W]): A {
    const node = this.ensureNode(atom)
    const result = f(node.value())
    atom.write(node.writeContext, result[1])
    return result[0]
  }

  update<R, W>(atom: Atom.Writable<R, W>, f: (_: R) => W): void {
    const node = this.ensureNode(atom)
    atom.write(node.writeContext, f(node.value()))
  }

  refresh = <A>(atom: Atom.Atom<A>): void => {
    if (atom.refresh !== undefined) {
      atom.refresh(this.refresh)
    } else {
      this.invalidateAtom(atom)
    }
  }

  subscribe<A>(atom: Atom.Atom<A>, f: (_: A) => void, options?: { readonly immediate?: boolean }): () => void {
    const node = this.ensureNode(atom)
    if (options?.immediate) {
      f(node.value())
    }
    const remove = node.subscribe(function() {
      f(node._value)
    })
    return () => {
      remove()
      if (node.canBeRemoved) {
        this.scheduleNodeRemoval(node)
      }
    }
  }

  mount<A>(atom: Atom.Atom<A>) {
    return this.subscribe(atom, constVoid, constImmediate)
  }

  atomHasTtl(atom: Atom.Atom<any>): boolean {
    return !atom.keepAlive && atom.idleTTL !== 0 && (atom.idleTTL !== undefined || this.defaultIdleTTL !== undefined)
  }

  ensureNode<A>(atom: Atom.Atom<A>): NodeImpl<A> {
    const key = atomKey(atom)
    let node = this.nodes.get(key)
    if (node === undefined) {
      node = this.createNode(atom)
      this.nodes.set(key, node)
      this.onNodeAdded?.(node)
    } else if (this.atomHasTtl(atom)) {
      this.removeNodeTimeout(node)
    }
    if (typeof key === "string" && this.preloadedSerializable.has(key)) {
      const encoded = this.preloadedSerializable.get(key)
      this.preloadedSerializable.delete(key)
      const decoded = (atom as any as Atom.Serializable<any>)[SerializableTypeId].decode(encoded)
      node.setValue(decoded)
    }
    return node
  }

  createNode<A>(atom: Atom.Atom<A>): NodeImpl<A> {
    if (this.disposed) {
      throw new Error(`Cannot access Atom ${atom}: registry is disposed`)
    }

    if (!atom.keepAlive) {
      this.scheduleAtomRemoval(atom)
    }
    return new NodeImpl(this, atom)
  }

  invalidateAtom = <A>(atom: Atom.Atom<A>): void => {
    this.ensureNode(atom).invalidate()
  }

  scheduleAtomRemoval(atom: Atom.Atom<any>): void {
    this.dispatcher.scheduleTask(() => {
      const node = this.nodes.get(atomKey(atom))
      if (node !== undefined && node.canBeRemoved) {
        this.removeNode(node)
      }
    }, 0)
  }

  scheduleNodeRemoval(node: NodeImpl<any>): void {
    this.dispatcher.scheduleTask(() => {
      if (node.canBeRemoved) {
        this.removeNode(node)
      }
    }, 0)
  }

  removeNode(node: NodeImpl<any>): void {
    if (this.atomHasTtl(node.atom)) {
      this.setNodeTimeout(node)
    } else {
      this.nodes.delete(atomKey(node.atom))
      node.remove()
      this.onNodeRemoved?.(node)
    }
  }

  setNodeTimeout(node: NodeImpl<any>): void {
    if (this.nodeTimeoutBucket.has(node)) {
      return
    }

    let idleTTL = node.atom.idleTTL ?? this.defaultIdleTTL!
    if (this.#currentSweepTTL !== null) {
      idleTTL -= this.#currentSweepTTL
      if (idleTTL <= 0) {
        this.nodes.delete(atomKey(node.atom))
        node.remove()
        this.onNodeRemoved?.(node)
        return
      }
    }
    const ttl = Math.ceil(idleTTL! / this.timeoutResolution) * this.timeoutResolution
    const timestamp = Date.now() + ttl
    const bucket = timestamp - (timestamp % this.timeoutResolution) + this.timeoutResolution

    let entry = this.timeoutBuckets.get(bucket)
    if (entry === undefined) {
      entry = [
        new Set<NodeImpl<any>>(),
        setTimeout(() => this.sweepBucket(bucket), bucket - Date.now()) as any
      ]
      this.timeoutBuckets.set(bucket, entry)
    }
    entry[0].add(node)
    this.nodeTimeoutBucket.set(node, bucket)
  }

  removeNodeTimeout(node: NodeImpl<any>): void {
    const bucket = this.nodeTimeoutBucket.get(node)
    if (bucket === undefined) return
    this.nodeTimeoutBucket.delete(node)
    this.scheduleNodeRemoval(node)

    const [nodes, handle] = this.timeoutBuckets.get(bucket)!
    nodes.delete(node)
    if (nodes.size === 0) {
      clearTimeout(handle)
      this.timeoutBuckets.delete(bucket)
    }
  }

  #currentSweepTTL: number | null = null
  sweepBucket(bucket: number): void {
    const nodes = this.timeoutBuckets.get(bucket)![0]
    this.timeoutBuckets.delete(bucket)

    nodes.forEach((node) => {
      this.nodeTimeoutBucket.delete(node)
      if (!node.canBeRemoved) return
      this.nodes.delete(atomKey(node.atom))
      this.onNodeRemoved?.(node)
      this.#currentSweepTTL = node.atom.idleTTL ?? this.defaultIdleTTL!
      node.remove()
      this.#currentSweepTTL = null
    })
  }

  reset(): void {
    this.timeoutBuckets.forEach(([, handle]) => clearTimeout(handle))
    this.timeoutBuckets.clear()
    this.nodeTimeoutBucket.clear()

    this.nodes.forEach((node) => {
      node.remove()
      this.onNodeRemoved?.(node)
    })
    this.nodes.clear()
  }

  dispose(): void {
    this.disposed = true
    this.reset()
  }
}

const NodeFlags = {
  alive: 1, // 1 << 0
  initialized: 2, // 1 << 1,
  waitingForValue: 4 // 1 << 2
} as const
type NodeFlags = typeof NodeFlags[keyof typeof NodeFlags]

const NodeState = {
  uninitialized: NodeFlags.alive | NodeFlags.waitingForValue,
  stale: NodeFlags.alive | NodeFlags.initialized | NodeFlags.waitingForValue,
  valid: NodeFlags.alive | NodeFlags.initialized,
  removed: 0
} as const
type NodeState = number

class NodeImpl<A> {
  constructor(
    registry: RegistryImpl,
    atom: Atom.Atom<A>
  ) {
    this.registry = registry
    this.atom = atom
    this.writeContext = new WriteContextImpl(registry, this)
  }

  readonly registry: RegistryImpl
  readonly atom: Atom.Atom<A>
  state: NodeState = NodeState.uninitialized
  lifetime: Lifetime<A> | undefined
  writeContext: WriteContextImpl<A>
  preserveInitialValueOnBuild = false

  parents: Array<NodeImpl<any>> = []
  previousParents: Array<NodeImpl<any>> | undefined
  children: Array<NodeImpl<any>> = []
  listeners: Set<() => void> = new Set()
  skipInvalidation = false

  currentState() {
    switch (this.state) {
      case NodeState.uninitialized:
        return "uninitialized"
      case NodeState.stale:
        return "stale"
      case NodeState.valid:
        return "valid"
      default:
        return "removed"
    }
  }

  get canBeRemoved(): boolean {
    return !this.atom.keepAlive && this.listeners.size === 0 && this.children.length === 0 && this.state !== 0
  }

  _value: A = undefined as any
  value(): A {
    if ((this.state & NodeFlags.waitingForValue) !== 0) {
      this.lifetime = makeLifetime(this)
      const value = this.atom.read(this.lifetime)
      if ((this.state & NodeFlags.waitingForValue) !== 0) {
        if (this.preserveInitialValueOnBuild) {
          this.preserveInitialValueOnBuild = false
          this.state = NodeState.valid
        } else {
          this.setValue(value)
        }
      }

      if (this.previousParents) {
        const parents = this.previousParents
        this.previousParents = undefined
        for (let i = 0; i < parents.length; i++) {
          parents[i].removeChild(this)
          if (parents[i].canBeRemoved) {
            this.registry.scheduleNodeRemoval(parents[i])
          }
        }
      }
    }

    return this._value
  }

  valueOption(): Option.Option<A> {
    if ((this.state & NodeFlags.initialized) === 0) {
      return Option.none()
    }
    return Option.some(this._value)
  }

  setInitialValue(value: A): void {
    if ((this.state & NodeFlags.initialized) === 0) {
      this.preserveInitialValueOnBuild = true
      this.state = NodeState.stale
      this._value = value

      if (batchState.phase === BatchPhase.collect) {
        batchState.notify.add(this)
      } else {
        this.notify()
      }

      return
    }

    this.setValue(value)
  }

  setValue(value: A): void {
    if ((this.state & NodeFlags.initialized) === 0) {
      this.state = NodeState.valid
      this._value = value

      if (batchState.phase === BatchPhase.collect) {
        batchState.notify.add(this)
      } else {
        this.notify()
      }

      return
    }

    this.state = NodeState.valid
    if (Object.is(this._value, value)) {
      return
    }

    this._value = value
    if (this.skipInvalidation) {
      this.skipInvalidation = false
    } else {
      this.invalidateChildren()
    }

    if (this.listeners.size > 0) {
      if (batchState.phase === BatchPhase.collect) {
        batchState.notify.add(this)
      } else {
        this.notify()
      }
    }
  }

  addParent(parent: NodeImpl<any>): void {
    this.parents.push(parent)
    if (this.previousParents !== undefined) {
      const index = this.previousParents.indexOf(parent)
      if (index !== -1) {
        this.previousParents[index] = this.previousParents[this.previousParents.length - 1]
        if (this.previousParents.pop() === undefined) {
          this.previousParents = undefined
        }
      }
    }

    if (parent.children.indexOf(this) === -1) {
      parent.children.push(this)
      if (parent.skipInvalidation) {
        parent.skipInvalidation = false
      }
    }
  }

  removeChild(child: NodeImpl<any>): void {
    const index = this.children.indexOf(child)
    if (index !== -1) {
      this.children[index] = this.children[this.children.length - 1]
      this.children.pop()
    }
  }

  invalidate(): void {
    if (this.state === NodeState.valid) {
      this.state = NodeState.stale
      this.disposeLifetime()
    }

    if (batchState.phase === BatchPhase.collect) {
      batchState.stale.push(this)
    } else if (this.atom.lazy && this.listeners.size === 0 && !childrenAreActive(this.children)) {
      this.invalidateChildren()
      this.skipInvalidation = true
    } else {
      this.value()
    }
  }

  invalidateChildren(): void {
    if (this.children.length === 0) {
      return
    }

    const children = this.children
    this.children = []
    for (let i = 0; i < children.length; i++) {
      children[i].invalidate()
    }
  }

  notify(): void {
    this.listeners.forEach(notifyListener)

    if (batchState.phase === BatchPhase.commit) {
      batchState.notify.delete(this)
    }
  }

  disposeLifetime(): void {
    if (this.lifetime !== undefined) {
      this.lifetime.dispose()
      this.lifetime = undefined
    }

    if (this.parents.length !== 0) {
      this.previousParents = this.parents
      this.parents = []
    }
  }

  remove() {
    this.state = NodeState.removed
    this.listeners.clear()

    if (this.lifetime === undefined) {
      return
    }

    this.disposeLifetime()

    if (this.previousParents === undefined) {
      return
    }

    const parents = this.previousParents
    this.previousParents = undefined
    for (let i = 0; i < parents.length; i++) {
      parents[i].removeChild(this)
      if (parents[i].canBeRemoved) {
        this.registry.removeNode(parents[i])
      }
    }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}

function childrenAreActive(children: Array<NodeImpl<any>>): boolean {
  if (children.length === 0) {
    return false
  }
  let current: Array<NodeImpl<any>> | undefined = children
  let stack: Array<Array<NodeImpl<any>>> | undefined
  let stackIndex = 0
  while (current !== undefined) {
    for (let i = 0, len = current.length; i < len; i++) {
      const child = current[i]
      if (!child.atom.lazy || child.listeners.size > 0) {
        return true
      } else if (child.children.length > 0) {
        if (stack === undefined) {
          stack = [child.children]
        } else {
          stack.push(child.children)
        }
      }
    }
    current = stack?.[stackIndex++]
  }
  return false
}

interface Lifetime<A> extends Atom.AtomContext {
  isFn: boolean
  readonly node: NodeImpl<A>
  finalizers: Array<() => void> | undefined
  disposed: boolean
  readonly dispose: () => void
}

const LifetimeProto: Omit<Lifetime<any>, "node" | "finalizers" | "disposed" | "isFn"> = {
  get registry(): RegistryImpl {
    return (this as Lifetime<any>).node.registry
  },

  addFinalizer(this: Lifetime<any>, f: () => void): void {
    if (this.disposed) return f()
    this.finalizers ??= []
    this.finalizers.push(f)
  },

  get<A>(this: Lifetime<any>, atom: Atom.Atom<A>): A {
    if (this.disposed) {
      return this.node.registry.get(atom)
    }
    const parent = this.node.registry.ensureNode(atom)
    this.node.addParent(parent)
    return parent.value()
  },

  result<A, E>(this: Lifetime<any>, atom: Atom.Atom<Result.AsyncResult<A, E>>, options?: {
    readonly suspendOnWaiting?: boolean | undefined
  }): Effect.Effect<A, E> {
    if (this.disposed || this.isFn) {
      return this.resultOnce(atom, options)
    }
    const result = this.get(atom)
    if (options?.suspendOnWaiting && result.waiting) {
      return Effect.never
    }
    switch (result._tag) {
      case "Initial": {
        return Effect.never
      }
      case "Failure": {
        return Exit.failCause(result.cause)
      }
      case "Success": {
        return Effect.succeed(result.value)
      }
    }
  },

  resultOnce<A, E>(this: Lifetime<any>, atom: Atom.Atom<Result.AsyncResult<A, E>>, options?: {
    readonly suspendOnWaiting?: boolean | undefined
  }): Effect.Effect<A, E> {
    return Effect.callback<A, E>((resume) => {
      const result = this.once(atom)
      if (result._tag !== "Initial" && !(options?.suspendOnWaiting && result.waiting)) {
        return resume(Result.toExit(result) as any)
      }
      const cancel = this.node.registry.subscribe(atom, (result) => {
        if (result._tag === "Initial" || (options?.suspendOnWaiting && result.waiting)) return
        cancel()
        resume(Result.toExit(result) as any)
      }, { immediate: false })
      return Effect.sync(cancel)
    })
  },

  setResult<A, E, W>(
    this: Lifetime<any>,
    atom: Atom.Writable<Result.AsyncResult<A, E>, W>,
    value: W
  ): Effect.Effect<A, E> {
    if (this.disposed) return Effect.never
    this.node.registry.set(atom, value)
    return this.resultOnce(atom, { suspendOnWaiting: true })
  },

  some<A>(this: Lifetime<any>, atom: Atom.Atom<Option.Option<A>>): Effect.Effect<A> {
    if (this.disposed || this.isFn) {
      return this.someOnce(atom)
    }
    const result = this.get(atom)
    return result._tag === "None" ? Effect.never : Effect.succeed(result.value)
  },

  someOnce<A>(this: Lifetime<any>, atom: Atom.Atom<Option.Option<A>>): Effect.Effect<A> {
    return Effect.callback<A>((resume) => {
      const result = this.once(atom)
      if (Option.isSome(result)) {
        return resume(Effect.succeed(result.value))
      }
      const cancel = this.node.registry.subscribe(atom, (result) => {
        if (Option.isNone(result)) return
        cancel()
        resume(Effect.succeed(result.value))
      }, { immediate: false })
      return Effect.sync(cancel)
    })
  },

  once<A>(this: Lifetime<any>, atom: Atom.Atom<A>): A {
    return this.node.registry.get(atom)
  },

  self<A>(this: Lifetime<any>): Option.Option<A> {
    if (this.disposed) return Option.none()
    return this.node.valueOption() as any
  },

  refresh<A>(this: Lifetime<any>, atom: Atom.Atom<A>): void {
    if (this.disposed) return
    this.node.registry.refresh(atom)
  },

  refreshSelf(this: Lifetime<any>): void {
    if (this.disposed) return
    this.node.invalidate()
  },

  mount<A>(this: Lifetime<any>, atom: Atom.Atom<A>): void {
    if (this.disposed) return
    this.addFinalizer(this.node.registry.mount(atom))
  },

  subscribe<A>(this: Lifetime<any>, atom: Atom.Atom<A>, f: (_: A) => void, options?: {
    readonly immediate?: boolean
  }): void {
    if (this.disposed) return
    this.addFinalizer(this.node.registry.subscribe(atom, f, options))
  },

  setSelf<A>(this: Lifetime<any>, a: A): void {
    if (this.disposed) return
    this.node.setValue(a as any)
  },

  set<R, W>(this: Lifetime<any>, atom: Atom.Writable<R, W>, value: W): void {
    if (this.disposed) return
    this.node.registry.set(atom, value)
  },

  stream<A>(this: Lifetime<any>, atom: Atom.Atom<A>, options?: {
    readonly withoutInitialValue?: boolean
  }) {
    if (this.disposed) return Stream.empty
    return Stream.callback<A>((queue) =>
      Effect.sync(() => {
        this.subscribe(atom, (value) => Queue.offerUnsafe(queue, value), {
          immediate: !options?.withoutInitialValue
        })
      })
    )
  },

  streamResult<A, E>(this: Lifetime<any>, atom: Atom.Atom<Result.AsyncResult<A, E>>, options?: {
    readonly withoutInitialValue?: boolean
    readonly bufferSize?: number
  }): Stream.Stream<A, E> {
    return this.stream(atom, options).pipe(
      Stream.filter(Result.isNotInitial),
      Stream.mapEffect((result) =>
        result._tag === "Success" ? Effect.succeed(result.value) : Effect.failCause(result.cause)
      )
    )
  },

  dispose(this: Lifetime<any>): void {
    this.disposed = true
    if (this.finalizers === undefined) {
      return
    }

    const finalizers = this.finalizers
    this.finalizers = undefined
    for (let i = finalizers.length - 1; i >= 0; i--) {
      finalizers[i]()
    }
  }
}

const makeLifetime = <A>(node: NodeImpl<A>): Lifetime<A> => {
  function get<A>(atom: Atom.Atom<A>): A {
    if (get.disposed) {
      return node.registry.get(atom)
    } else if (get.isFn) {
      return node.registry.get(atom)
    }
    const parent = node.registry.ensureNode(atom)
    const value = parent.value()
    node.addParent(parent)
    return value
  }
  Object.setPrototypeOf(get, LifetimeProto)
  get.isFn = false
  get.disposed = false
  get.finalizers = undefined
  get.node = node
  return get as any
}

class WriteContextImpl<A> implements Atom.WriteContext<A> {
  constructor(
    registry: RegistryImpl,
    node: NodeImpl<A>
  ) {
    this.registry = registry
    this.node = node
  }
  readonly registry: RegistryImpl
  readonly node: NodeImpl<A>
  get<A>(atom: Atom.Atom<A>): A {
    return this.registry.get(atom)
  }
  set<R, W>(atom: Atom.Writable<R, W>, value: W) {
    return this.registry.set(atom, value)
  }
  setSelf(value: any) {
    return this.node.setValue(value)
  }
  refreshSelf() {
    return this.node.invalidate()
  }
}

// -----------------------------------------------------------------------------
// batching
// -----------------------------------------------------------------------------

/** @internal */
export const BatchPhase = {
  disabled: 0,
  collect: 1,
  commit: 2
} as const

/** @internal */
export type BatchPhase = typeof BatchPhase[keyof typeof BatchPhase]

/** @internal */
export const batchState = {
  phase: BatchPhase.disabled as BatchPhase,
  depth: 0,
  stale: [] as Array<NodeImpl<any>>,
  notify: new Set<NodeImpl<any>>()
}

/** @internal */
export function batch(f: () => void): void {
  batchState.phase = BatchPhase.collect
  batchState.depth++
  try {
    f()
    if (batchState.depth === 1) {
      for (let i = 0; i < batchState.stale.length; i++) {
        batchRebuildNode(batchState.stale[i])
      }
      batchState.phase = BatchPhase.commit
      for (const node of batchState.notify) {
        node.notify()
      }
      batchState.notify.clear()
    }
  } finally {
    batchState.depth--
    if (batchState.depth === 0) {
      batchState.phase = BatchPhase.disabled
      batchState.stale = []
    }
  }
}

function batchRebuildNode(node: NodeImpl<any>) {
  if (node.state === NodeState.valid) {
    return
  }

  for (let i = 0; i < node.parents.length; i++) {
    const parent = node.parents[i]
    if (parent.state !== NodeState.valid) {
      batchRebuildNode(parent)
    }
  }

  // @ts-ignore
  if (node.state !== NodeState.valid) {
    node.value()
  }
}
