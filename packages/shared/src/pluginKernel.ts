// @effect-diagnostics anyUnknownInErrorContext:off - Extension factories are an untrusted, runtime-validated API boundary.
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type * as Types from "effect/Types";

export interface PluginServiceDefinition {
  readonly key: string;
  readonly pluginId: string;
  readonly members: ReadonlyArray<string>;
  readonly bindings: number;
  readonly enabled: boolean;
  readonly lifecycle: boolean;
  readonly scopes: ReadonlyArray<string>;
}

export interface PluginServiceFactoryContext {
  readonly scope: string;
  readonly original: unknown;
  readonly services: {
    readonly get: (key: string) => unknown;
    readonly getBuiltin: (key: string) => unknown;
  };
  readonly Effect: typeof Effect;
  readonly Stream: typeof Stream;
  readonly Scope: typeof Scope;
}

export type PluginServiceFactory = (context: PluginServiceFactoryContext) => unknown;
export type PluginServiceWrapper = (args: ReadonlyArray<unknown>, next: () => unknown) => unknown;
export type PluginServiceContribution =
  | {
      readonly kind: "register";
      readonly key: string;
      readonly scope?: string;
      readonly factory: PluginServiceFactory;
    }
  | {
      readonly kind: "replace";
      readonly key: string;
      readonly scope?: string;
      readonly factory: PluginServiceFactory;
    }
  | {
      readonly kind: "wrap";
      readonly key: string;
      readonly scope?: string;
      readonly member: string;
      readonly run: PluginServiceWrapper;
    };

export interface PluginKernelShape {
  readonly registerBuiltin: <S, E, R>(
    pluginId: string,
    key: string,
    factory: Effect.Effect<S, E, R>,
    options?: {
      readonly lifecycle?: boolean;
      readonly internal?: boolean;
      readonly resourceOwner?: object;
    },
  ) => Effect.Effect<S, E, R | Scope.Scope>;
  readonly list: (scope?: string) => ReadonlyArray<PluginServiceDefinition>;
  readonly get: (key: string, scope?: string) => unknown;
  readonly getBuiltin: (key: string, scope?: string) => unknown;
  /** Factories stage atomically across every environment binding, and also apply to future bindings. */
  readonly stage: (
    pluginId: string,
    contributions: ReadonlyArray<PluginServiceContribution>,
    retain?: Effect.Effect<Effect.Effect<void>>,
    namespace?: string,
  ) => Effect.Effect<Effect.Effect<void>, PluginKernelError>;
  readonly setEnabled: (
    pluginId: string,
    enabled: boolean,
    scope?: string,
  ) => Effect.Effect<void, PluginKernelError>;
}

class PluginKernelError extends Schema.TaggedError<PluginKernelError>()("PluginKernelError", {
  message: Schema.String,
}) {}
export class PluginKernel extends Context.Service<PluginKernel, PluginKernelShape>()(
  "@t3tools/shared/pluginKernel",
) {}
export const PluginBindingScope = Context.Reference<string>("t3/plugins/PluginBindingScope", {
  defaultValue: () => "host",
});

interface Generation {
  readonly pluginId: string;
  readonly scope: Scope.Closeable;
  readonly value: unknown;
  readonly retain?: Effect.Effect<Effect.Effect<void>> | undefined;
  readonly dependencies?: ReadonlyArray<Generation>;
  leases: number;
  retired: boolean;
  closing: boolean;
}
interface Wrapper {
  readonly member: string;
  readonly run: PluginServiceWrapper;
  readonly generation: Generation;
}
interface Operation {
  readonly binding: Binding;
  readonly generation: Generation;
  readonly wrappers: ReadonlyArray<Wrapper>;
  readonly value: unknown;
}
interface Binding {
  readonly scope: string;
  readonly pluginId: string;
  readonly key: string;
  readonly factory: Effect.Effect<unknown, unknown, Scope.Scope>;
  readonly context: Context.Context<never>;
  readonly facade: object;
  readonly lifecycle: boolean;
  readonly internal: boolean;
  readonly resourceOwner: Binding | undefined;
  original: Generation | undefined;
  readonly members: Set<PropertyKey>;
  readonly replacements: Map<string, Generation>;
  readonly wrappers: Map<string, ReadonlyArray<Wrapper>>;
  group: Set<Binding>;
  readonly forwardable: boolean;
  forward?: Binding;
}
interface ContributionStage {
  readonly pluginId: string;
  readonly namespace: string;
  readonly contributions: ReadonlyArray<PluginServiceContribution>;
  readonly retain?: Generation["retain"];
  readonly installed: Map<
    Binding,
    { readonly replacement: Generation | undefined; readonly wrappers: ReadonlyArray<Wrapper> }
  >;
  readonly definitions: Array<{ readonly binding: Binding; readonly scope: Scope.Closeable }>;
}
interface BindingOptions {
  readonly lifecycle?: boolean;
  readonly internal?: boolean;
  readonly resourceOwner?: object;
  readonly deferred?: boolean;
  readonly retain?: Generation["retain"];
  readonly onCreated?: (binding: Binding) => void;
}
interface InvocationBinding {
  readonly generation: Generation;
  readonly wrappers: ReadonlyMap<string, ReadonlyArray<Wrapper>>;
  readonly lifetime: { active: boolean };
  readonly parent: InvocationBinding | undefined;
}
const InvocationBindings = Context.Reference<ReadonlyMap<Binding, InvocationBinding>>(
  "t3/plugins/InvocationBindings",
  { defaultValue: () => new Map() },
);
const PreparingServices = Context.Reference<ReadonlySet<string>>("t3/plugins/PreparingServices", {
  defaultValue: () => new Set(),
});
const invocationBindings = () => {
  const fiber = Fiber.getCurrent();
  return fiber ? Context.get(fiber.context, InvocationBindings) : undefined;
};
const activePin = (initial: InvocationBinding | undefined) => {
  let pin = initial;
  while (pin && !pin.lifetime.active) pin = pin.parent;
  return pin;
};

const error = (cause: unknown) =>
  new PluginKernelError({ message: cause instanceof Error ? cause.message : String(cause) });
const checked = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.catchCause((cause) =>
      Effect.fail(new PluginKernelError({ message: Cause.pretty(cause) })),
    ),
  );
/** Extension code uses the captured host dependencies and the invocation's resource scope. */
const isExtensionEffect = (value: unknown): value is Effect.Effect<unknown, unknown, Scope.Scope> =>
  Effect.isEffect(value);
const isExtensionStream = (value: unknown): value is Stream.Stream<unknown, unknown, Scope.Scope> =>
  Stream.isStream(value);
const toEffect = (value: unknown): Effect.Effect<unknown, unknown, Scope.Scope> =>
  isExtensionEffect(value)
    ? value
    : value instanceof Promise
      ? Effect.tryPromise({ try: () => value, catch: error })
      : Effect.succeed(value);
const property = (value: unknown, member: PropertyKey) => {
  if ((typeof value !== "object" || value === null) && typeof value !== "function")
    throw new Error("A service factory must return an object or function.");
  return Reflect.get(value, member);
};
const memberKeys = (value: unknown) => {
  const keys = new Set<PropertyKey>();
  let object = Object(value);
  while (object && object !== Object.prototype && object !== Function.prototype) {
    for (const key of Reflect.ownKeys(object)) if (key !== "constructor") keys.add(key);
    object = Object.getPrototypeOf(object);
  }
  return keys;
};

/** Snapshot first so cleanup can mutate its source; Hermes has no toReversed. */
function* backwards<Value>(source: Iterable<Value>) {
  const values = Array.from(source);
  for (let index = values.length - 1; index >= 0; index--) yield values[index]!;
}

const make = Effect.fn("PluginKernel.make")(function* (
  initialEnabled: Readonly<Record<string, boolean>>,
) {
  const rootScope = yield* Scope.Scope;
  const services = yield* Effect.context<never>();
  const runSync = Effect.runSyncWith(services);
  const runPromise = Effect.runPromiseWith(services);
  const bindings = new Map<string, Set<Binding>>();
  const facadeBindings = new WeakMap<object, Binding>();
  const stages = new Map<string, ContributionStage>();
  const enabled = new Map(Object.entries(initialEnabled));
  const bindingEnabled = (binding: Pick<Binding, "pluginId" | "scope">) =>
    (enabled.get(`${binding.scope}:${binding.pluginId}`) ??
      (binding.scope === "host" ? enabled.get(binding.pluginId) : undefined)) !== false;
  const live = new Set<Generation>();
  const close = (generation: Generation) =>
    Effect.suspend(() => {
      // A finalizer can interrupt a fiber whose lease release reaches this same scope.
      // Reentering Scope.close would wait for the finalizer that is waiting for that fiber.
      if (generation.closing) return Effect.void;
      generation.closing = true;
      const cleanup = Scope.close(generation.scope, Exit.void);
      return (
        generation.retain
          ? cleanup.pipe(
              Effect.interruptible,
              Effect.timeoutOrElse({
                duration: "10 seconds",
                orElse: () =>
                  Effect.logWarning("Plugin service cleanup exceeded 10 seconds", {
                    pluginId: generation.pluginId,
                  }),
              }),
            )
          : cleanup
      ).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            live.delete(generation);
          }),
        ),
      );
    });
  const retire = Effect.fn("PluginKernel.retire")(function* (generation: Generation) {
    generation.retired = true;
    if (generation.leases === 0) yield* close(generation);
  });
  const release = Effect.fn("PluginKernel.release")(function* (generation: Generation) {
    generation.leases -= 1;
    if (generation.retired && generation.leases === 0) yield* close(generation);
  });
  const acquire = Effect.fn("PluginKernel.acquire")(function* (
    generation: Generation,
    alreadyPinned = false,
  ) {
    if (generation.retired && (!alreadyPinned || generation.leases === 0))
      return yield* Effect.die(new Error("This plugin service generation has retired."));
    generation.leases += 1;
    return release(generation);
  });
  const build = <A, E>(
    pluginId: string,
    factory: Effect.Effect<A, E, Scope.Scope>,
    retain?: Generation["retain"],
  ) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        const construction = Effect.gen(function* () {
          // The extension module's generation lives for the full contributed resource scope.
          // This supports asynchronous owners without running their retain effects synchronously.
          if (retain) yield* Scope.addFinalizer(scope, yield* retain);
          return yield* factory.pipe(Effect.provideService(Scope.Scope, scope));
        });
        const result = yield* restore(construction).pipe(Effect.exit);
        if (Exit.isFailure(result)) {
          yield* Scope.close(scope, Exit.void);
          return yield* Effect.failCause(result.cause);
        }
        const generation: Generation = {
          pluginId,
          scope,
          value: result.value,
          retain,
          leases: 0,
          retired: false,
          closing: false,
        };
        live.add(generation);
        return generation;
      }),
    );
  yield* Scope.addFinalizer(
    rootScope,
    Effect.gen(function* () {
      // Factories are acquired after their dependencies, so stop consumers before their resources.
      for (const generation of backwards(live)) yield* close(generation).pipe(Effect.ignore);
    }),
  );

  const latest = (key: string, scope = "host") => {
    let binding: Binding | undefined;
    for (const candidate of bindings.get(key) ?? [])
      if (!candidate.internal && candidate.scope === scope) binding = candidate;
    if (!binding) throw new Error(`Unknown plugin service '${key}'.`);
    return binding;
  };
  const effective = (initial: Binding): Binding => {
    let binding = initial;
    while (binding.forward) binding = binding.forward;
    if (
      binding.forwardable &&
      (!binding.original || binding.original.retired) &&
      binding.replacements.size === 0
    ) {
      const replacement = [...(bindings.get(binding.key) ?? [])].findLast(
        (candidate) =>
          candidate !== binding &&
          candidate.scope === binding.scope &&
          candidate.pluginId === binding.pluginId &&
          !candidate.original?.retired,
      );
      if (replacement) return replacement;
    }
    if (binding !== initial) initial.forward = binding;
    return binding;
  };
  const selected = (initial: Binding): Generation => {
    const binding = effective(initial);
    const pinned =
      activePin(invocationBindings()?.get(initial)) ??
      activePin(invocationBindings()?.get(binding));
    if (pinned) return pinned.generation;
    if (!bindingEnabled(binding)) throw new Error(`Plugin '${binding.pluginId}' is disabled.`);
    const generation = [...binding.replacements.values()].at(-1) ?? binding.original;
    if (!generation)
      throw new Error(`Plugin '${binding.pluginId}' has no active service '${binding.key}'.`);
    return generation;
  };
  const wrappersFor = (binding: Binding, member: PropertyKey) => {
    const effectiveBinding = effective(binding);
    const pinned =
      activePin(invocationBindings()?.get(binding)) ??
      activePin(invocationBindings()?.get(effectiveBinding));
    return [...(pinned?.wrappers ?? effectiveBinding.wrappers).values()]
      .flat()
      .filter((wrapper) => wrapper.member === member);
  };
  const call = (
    generation: Generation,
    member: PropertyKey | undefined,
    args: ReadonlyArray<unknown>,
  ) => {
    const method = member === undefined ? generation.value : property(generation.value, member);
    if (typeof method !== "function" && member !== undefined && args.length === 0) return method;
    if (typeof method !== "function")
      throw new Error(`Service member '${String(member)}' is not callable.`);
    return Reflect.apply(method, member === undefined ? undefined : generation.value, args);
  };
  const cacheProtocol = (value: unknown): unknown => {
    if (!isExtensionEffect(value)) return value;
    const cached = runSync(Effect.cached(value));
    const members = new Map<PropertyKey, unknown>();
    return new Proxy(cached, {
      get: (target, member, receiver) => {
        if (Reflect.has(target, member)) return Reflect.get(target, member, receiver);
        if (members.has(member)) return members.get(member);
        const original = property(value, member);
        const derived =
          typeof original === "function"
            ? (...args: ReadonlyArray<unknown>) =>
                cacheProtocol(Reflect.apply(original, value, args))
            : cacheProtocol(original);
        members.set(member, derived);
        return derived;
      },
      has: (target, member) => Reflect.has(target, member) || member in Object(value),
      getPrototypeOf: () => Object.getPrototypeOf(Object(value)),
    });
  };
  const memoized = (run: () => unknown) => {
    let called = false;
    let value: unknown;
    let failure: unknown;
    let failed = false;
    return () => {
      if (!called) {
        called = true;
        try {
          value = run();
          value = cacheProtocol(value);
        } catch (cause) {
          failed = true;
          failure = cause;
        }
      }
      if (failed) throw failure;
      return value;
    };
  };
  const chain = (
    generation: Generation,
    wrappers: ReadonlyArray<Wrapper>,
    member: PropertyKey | undefined,
    args: ReadonlyArray<unknown>,
  ) => {
    if (wrappers.length === 0) return call(generation, member, args);
    let next = memoized(() => call(generation, member, args));
    for (const wrapper of wrappers) {
      const previous = next;
      next = memoized(() => wrapper.run(args, previous));
    }
    return next();
  };
  const leaseMany = Effect.fn("PluginKernel.leaseMany")(function* (
    owners: ReadonlyArray<Generation>,
  ) {
    const releases: Effect.Effect<void>[] = [];
    const expanded = [
      ...new Set(owners.flatMap((owner) => [owner, ...(owner.dependencies ?? [])])),
    ];
    const pins = invocationBindings();
    const pinnedOwners = new Set(
      [...(pins?.values() ?? [])].flatMap((initial) => {
        const pin = activePin(initial);
        return pin
          ? [
              pin.generation,
              ...(pin.generation.dependencies ?? []),
              ...[...pin.wrappers.values()].flat().map((wrapper) => wrapper.generation),
            ]
          : [];
      }),
    );
    const outcome = yield* Effect.forEach(expanded, (owner) =>
      acquire(owner, pinnedOwners.has(owner)).pipe(
        Effect.tap((finalize) =>
          Effect.sync(() => {
            releases.push(finalize);
          }),
        ),
      ),
    ).pipe(Effect.exit);
    if (Exit.isFailure(outcome)) {
      yield* Effect.forEach(backwards(releases), (finalize) => finalize, { discard: true });
      return yield* Effect.failCause(outcome.cause);
    }
    return Effect.forEach(backwards(releases), (finalize) => finalize, { discard: true });
  });
  const pinOperation = (operation: Operation) => {
    const inherited = new Map<Binding, InvocationBinding>();
    for (const [binding, initial] of invocationBindings() ?? []) {
      const active = activePin(initial);
      if (active) inherited.set(binding, active);
    }
    const resolved = effective(operation.binding);
    const parent = inherited.get(operation.binding) ?? inherited.get(resolved);
    const pin: InvocationBinding = {
      generation: parent?.generation ?? operation.generation,
      wrappers: parent?.wrappers ?? new Map(resolved.wrappers),
      lifetime: { active: true },
      parent,
    };
    const context = new Map(inherited);
    context.set(operation.binding, pin);
    context.set(resolved, pin);
    return {
      context,
      expire: Effect.sync(() => {
        pin.lifetime.active = false;
      }),
      owners: [
        operation.generation,
        ...[...pin.wrappers.values()].flat().map((wrapper) => wrapper.generation),
      ],
    };
  };
  /** Retain Effect/Stream subtypes such as SQL Statements, including their fluent API and brands. */
  const preserveProtocol = (leased: object, initial: unknown, choose: () => Operation): object =>
    new Proxy(leased, {
      get: (target, member, receiver) => {
        if (Reflect.has(target, member)) return Reflect.get(target, member, receiver);
        const value = property(initial, member);
        if (typeof value === "function")
          return (...args: ReadonlyArray<unknown>) => {
            const result = Reflect.apply(value, initial, args);
            return scopedResult(result, () => {
              const operation = choose();
              const method = property(operation.value, member);
              if (typeof method !== "function")
                throw new Error("A replacement changed a fluent service method.");
              return { ...operation, value: Reflect.apply(method, operation.value, args) };
            });
          };
        return scopedResult(value, () => {
          const operation = choose();
          return { ...operation, value: property(operation.value, member) };
        });
      },
      has: (target, member) => Reflect.has(target, member) || member in Object(initial),
      getPrototypeOf: () => Object.getPrototypeOf(Object(initial)),
    });
  const scopedResult = (initial: unknown, choose: () => Operation): unknown => {
    if (isExtensionEffect(initial)) {
      const leased = Effect.suspend(() => {
        const operation = choose();
        const pinned = pinOperation(operation);
        return Effect.acquireUseRelease(
          leaseMany(pinned.owners),
          () =>
            isExtensionEffect(operation.value)
              ? operation.value.pipe(Effect.provideService(InvocationBindings, pinned.context))
              : Effect.die(
                  new Error("A service replacement changed an Effect method's return kind."),
                ),
          (finalize) => pinned.expire.pipe(Effect.andThen(finalize)),
        );
      });
      return preserveProtocol(leased, initial, choose);
    }
    if (isExtensionStream(initial)) {
      const leased = Stream.unwrap(
        Effect.gen(function* () {
          const operation = choose();
          const pinned = pinOperation(operation);
          const finalize = yield* leaseMany(pinned.owners);
          yield* Effect.addFinalizer(() => pinned.expire.pipe(Effect.andThen(finalize)));
          if (!isExtensionStream(operation.value))
            return yield* Effect.die(
              new Error("A service replacement changed a Stream method's return kind."),
            );
          return operation.value.pipe(Stream.provideService(InvocationBindings, pinned.context));
        }),
      );
      return preserveProtocol(leased, initial, choose);
    }
    return initial;
  };
  const invoke = (
    binding: Binding,
    member: PropertyKey | undefined,
    args: ReadonlyArray<unknown>,
  ) => {
    const initial = selected(binding);
    const initialWrappers = member === undefined ? [] : wrappersFor(binding, member);
    // Construction happens synchronously. This also protects native Promises which start immediately.
    const initialOwners = [
      ...new Set(
        [initial, ...initialWrappers.map((wrapper) => wrapper.generation)].flatMap((owner) => [
          owner,
          ...(owner.dependencies ?? []),
        ]),
      ),
    ];
    const inheritedPins = invocationBindings();
    const alreadyPinned =
      activePin(inheritedPins?.get(binding)) ?? activePin(inheritedPins?.get(effective(binding)));
    for (const owner of initialOwners)
      if (owner.retired && (!alreadyPinned || owner.leases === 0))
        throw new Error(`Plugin service '${binding.key}' generation has retired.`);
    for (const owner of initialOwners) owner.leases += 1;
    const initialRelease = () => {
      const pending: Promise<void>[] = [];
      for (const owner of backwards(initialOwners)) {
        owner.leases -= 1;
        if (owner.retired && owner.leases === 0) pending.push(runPromise(close(owner)));
      }
      return pending.length ? Promise.all(pending).then(() => undefined) : undefined;
    };
    let result: unknown;
    try {
      result = chain(initial, initialWrappers, member, args);
    } catch (cause) {
      initialRelease()?.catch(() => {});
      throw cause;
    }
    if (result instanceof Promise) return result.finally(initialRelease);
    // Effect and Stream values are cold. They select and retain a live implementation when consumed.
    initialRelease()?.catch(() => {});
    let consumed = false;
    const current = () => {
      const generation = selected(binding);
      const wrappers = member === undefined ? [] : wrappersFor(binding, member);
      const unchanged =
        generation === initial &&
        wrappers.length === initialWrappers.length &&
        wrappers.every((wrapper, index) => wrapper === initialWrappers[index]);
      const value = unchanged && !consumed ? result : chain(generation, wrappers, member, args);
      consumed = true;
      return { binding, generation, wrappers, value };
    };
    return scopedResult(result, current);
  };

  const get = (key: string, scope?: string) => latest(key, scope).facade;
  const getBuiltin = (key: string, scope?: string) => latest(key, scope).original?.value;
  const contextFor = (binding: Binding): PluginServiceFactoryContext => ({
    scope: binding.scope,
    original: binding.original?.value,
    services: {
      get: (key) =>
        binding.context.mapUnsafe.has(key)
          ? binding.context.mapUnsafe.get(key)
          : get(key, binding.scope),
      getBuiltin: (key) => {
        const dependency = binding.context.mapUnsafe.get(key);
        const owner =
          dependency && (typeof dependency === "object" || typeof dependency === "function")
            ? facadeBindings.get(dependency)
            : undefined;
        return owner
          ? owner.original?.value
          : binding.context.mapUnsafe.has(key)
            ? dependency
            : getBuiltin(key, binding.scope);
      },
    },
    Effect,
    Stream,
    Scope,
  });
  const prepare = (stage: ContributionStage, binding: Binding) =>
    checked(
      Effect.gen(function* () {
        if (!bindingEnabled(binding))
          return { replacement: undefined, wrappers: [] as ReadonlyArray<Wrapper> };
        const contributions = stage.contributions.filter(
          (contribution) =>
            contribution.key === binding.key &&
            (contribution.scope === undefined || contribution.scope === binding.scope),
        );
        const resources: Generation[] = [];
        let replacement: Generation | undefined;
        const wrappers: Wrapper[] = [];
        const outcome = yield* checked(
          Effect.gen(function* () {
            for (const contribution of contributions) {
              if (contribution.kind === "register") continue;
              if (contribution.kind === "replace") {
                if (replacement) throw new Error(`Duplicate service replacement '${binding.key}'.`);
                const originalDependency = !binding.lifecycle ? binding.original : undefined;
                const replacementFactory = Effect.gen(function* () {
                  if (originalDependency)
                    yield* Effect.acquireRelease(
                      Effect.sync(() => {
                        if (originalDependency.retired)
                          throw new Error("The original service generation has retired.");
                        originalDependency.leases += 1;
                      }),
                      () => release(originalDependency),
                    );
                  return yield* Effect.try({
                    try: () => contribution.factory(contextFor(binding)),
                    catch: error,
                  }).pipe(Effect.flatMap(toEffect));
                });
                const constructing = yield* PreparingServices;
                replacement = yield* build(stage.pluginId, replacementFactory, stage.retain).pipe(
                  Effect.provideService(
                    PreparingServices,
                    new Set([...constructing, `${binding.scope}:${binding.key}`]),
                  ),
                  Effect.provideService(PluginBindingScope, binding.scope),
                );
                resources.push(replacement);
                if (binding.original && !binding.lifecycle)
                  Object.defineProperty(replacement, "dependencies", {
                    value: [binding.original],
                  });
                if (
                  binding.original &&
                  (binding.original.value === null ||
                    (typeof binding.original.value !== "object" &&
                      typeof binding.original.value !== "function")) &&
                  replacement.value !== binding.original.value
                )
                  throw new Error(
                    `Primitive service '${binding.key}' requires rebuilding its host runtime; use an object service for live replacement.`,
                  );
                for (const member of binding.members) {
                  if (
                    binding.original &&
                    typeof property(binding.original.value, member) !==
                      typeof property(replacement.value, member)
                  )
                    throw new Error(
                      `Service replacement '${binding.key}' changes member '${String(member)}'.`,
                    );
                }
              } else {
                if (!binding.members.has(contribution.member))
                  throw new Error(`Unknown member '${contribution.member}' of '${binding.key}'.`);
                const generation = yield* build(stage.pluginId, Effect.undefined, stage.retain);
                resources.push(generation);
                wrappers.push({ member: contribution.member, run: contribution.run, generation });
              }
            }
          }),
        ).pipe(Effect.exit);
        if (Exit.isFailure(outcome)) {
          for (const generation of resources) yield* retire(generation);
          return yield* Effect.failCause(outcome.cause);
        }
        return { replacement, wrappers };
      }),
    );
  const publishBinding = (
    stage: ContributionStage,
    binding: Binding,
    value: {
      readonly replacement: Generation | undefined;
      readonly wrappers: ReadonlyArray<Wrapper>;
    },
  ) => {
    stage.installed.set(binding, value);
    if (value.replacement) binding.replacements.set(stage.pluginId, value.replacement);
    if (value.wrappers.length) binding.wrappers.set(stage.pluginId, value.wrappers);
  };
  const disposeStage = Effect.fn("PluginKernel.disposeStage")(function* (stage: ContributionStage) {
    if (stages.get(stage.pluginId) === stage) stages.delete(stage.pluginId);
    for (const [binding, installed] of stage.installed) {
      if (binding.replacements.get(stage.pluginId) === installed.replacement)
        binding.replacements.delete(stage.pluginId);
      if (binding.wrappers.get(stage.pluginId) === installed.wrappers)
        binding.wrappers.delete(stage.pluginId);
      if (installed.replacement) yield* retire(installed.replacement);
      for (const wrapper of installed.wrappers) yield* retire(wrapper.generation);
      if (
        binding.lifecycle &&
        !binding.original &&
        binding.replacements.size === 0 &&
        bindingEnabled(binding)
      )
        binding.original = yield* build(binding.pluginId, binding.factory).pipe(Effect.orDie);
    }
    stage.installed.clear();
    for (const definition of stage.definitions) yield* Scope.close(definition.scope, Exit.void);
    stage.definitions.length = 0;
  });

  const register = Effect.fn("PluginKernel.register")(function* <S, E, R>(
    pluginId: string,
    key: string,
    factory: Effect.Effect<S, E, R>,
    options?: BindingOptions,
  ) {
    const bindingScope = yield* PluginBindingScope;
    // A replacement can reuse the source Layer to create its implementation.
    // Registering that same key again would apply its own active contribution recursively.
    if ((yield* PreparingServices).has(`${bindingScope}:${key}`)) return yield* factory;
    const ownerScope = yield* Scope.Scope;
    const captured = (yield* Effect.context<Effect.Services<typeof factory>>()).pipe(
      Context.omit(InvocationBindings),
    );
    const resourceOwner = options?.resourceOwner
      ? facadeBindings.get(options.resourceOwner)
      : undefined;
    if (options?.resourceOwner && !resourceOwner)
      throw new Error("A shared resource owner must be a registered plugin service.");
    const create = Effect.gen(function* () {
      const scope = yield* Scope.Scope;
      // Every leaf source retains the exact shared factory generation until its own scope drains.
      if (resourceOwner)
        yield* Effect.acquireRelease(acquire(selected(resourceOwner)), (finalize) => finalize).pipe(
          Effect.asVoid,
        );
      return yield* factory.pipe(
        Effect.setContext(Context.add(captured, Scope.Scope, scope)),
        Effect.onError((cause) =>
          Effect.logError("Plugin source factory failed", {
            pluginId,
            key,
            cause: Cause.pretty(cause),
          }),
        ),
      );
    });
    const original = !bindingEnabled({ pluginId, scope: bindingScope })
      ? undefined
      : yield* build(pluginId, create, options?.retain);
    const members = original ? memberKeys(original.value) : new Set<PropertyKey>();
    const target =
      typeof original?.value === "function" ? function (..._args: ReadonlyArray<unknown>) {} : {};
    const proxy: object = new Proxy(target, {
      get: (_target, member) => {
        const value = property(selected(binding).value, member);
        if (typeof value === "function")
          return (...args: ReadonlyArray<unknown>) => invoke(binding, member, args);
        if (Effect.isEffect(value) || Stream.isStream(value) || wrappersFor(binding, member).length)
          return invoke(binding, member, []);
        return value;
      },
      apply: (_target, _thisArg, args) => invoke(binding, undefined, args),
      construct: (_target, args, newTarget): object => {
        const generation = selected(binding);
        if (typeof generation.value !== "function")
          throw new Error("This plugin service is not a constructor.");
        return Reflect.construct(
          generation.value,
          args,
          newTarget === facade ? generation.value : newTarget,
        );
      },
      ownKeys: () =>
        [...new Set([...Reflect.ownKeys(target), ...binding.members])].filter(
          (key): key is string | symbol => typeof key !== "number",
        ),
      has: (_target, member) => binding.members.has(member),
      getOwnPropertyDescriptor: (_target, member) => {
        const descriptor = Reflect.getOwnPropertyDescriptor(target, member);
        if (descriptor && !descriptor.configurable) return descriptor;
        return effective(binding).members.has(member)
          ? { configurable: true, enumerable: true }
          : descriptor;
      },
    });
    const facade: unknown =
      Effect.isEffect(original?.value) || Stream.isStream(original?.value)
        ? scopedResult(original?.value, () => {
            const generation = selected(binding);
            return { binding, generation, wrappers: [], value: generation.value };
          })
        : original &&
            (original.value === null ||
              (typeof original.value !== "object" && typeof original.value !== "function"))
          ? original.value
          : proxy;
    const group = bindings.get(key) ?? new Set<Binding>();
    const binding: Binding = {
      pluginId,
      key,
      scope: bindingScope,
      factory: create,
      context: captured.pipe(Context.omit(Scope.Scope)) as Context.Context<never>,
      facade: facade as object,
      lifecycle: options?.lifecycle ?? false,
      internal: options?.internal ?? false,
      resourceOwner,
      original,
      members,
      replacements: new Map(),
      wrappers: new Map(),
      group,
      forwardable: options?.deferred ?? false,
    };
    if (!options?.deferred) {
      group.add(binding);
      bindings.set(key, group);
    }
    if ((typeof facade === "object" && facade !== null) || typeof facade === "function")
      facadeBindings.set(facade, binding);
    yield* Scope.addFinalizer(
      ownerScope,
      Effect.gen(function* () {
        binding.group.delete(binding);
        if (binding.group.size === 0 && bindings.get(key) === binding.group) bindings.delete(key);
        for (const stage of stages.values()) {
          const installed = stage.installed.get(binding);
          if (installed) {
            stage.installed.delete(binding);
            if (installed.replacement) yield* retire(installed.replacement);
            for (const wrapper of installed.wrappers) yield* retire(wrapper.generation);
            if (!binding.forwardable) {
              if (installed.replacement) yield* close(installed.replacement);
              for (const wrapper of installed.wrappers) yield* close(wrapper.generation);
            }
          }
        }
        if (binding.original) {
          yield* retire(binding.original);
          // A host/environment scope ending is different from a hot replacement.
          // Its subscriptions must end now rather than retain the host's listeners forever.
          if (!binding.forwardable) yield* close(binding.original);
        }
      }),
    );
    options?.onCreated?.(binding);
    for (const stage of stages.values()) {
      if (binding.internal) continue;
      if (
        !stage.contributions.some(
          (contribution) =>
            contribution.key === key &&
            (contribution.scope === undefined || contribution.scope === bindingScope),
        )
      )
        continue;
      const prepared = yield* prepare(stage, binding).pipe(Effect.orDie);
      publishBinding(stage, binding, prepared);
    }
    if (binding.lifecycle && binding.replacements.size > 0 && binding.original) {
      const previous = binding.original;
      binding.original = undefined;
      yield* retire(previous);
    }
    return facade as Effect.Success<typeof factory>;
  });

  return PluginKernel.of({
    registerBuiltin: register,
    get,
    getBuiltin,
    list: (scope) =>
      [...bindings]
        .filter(([_key, group]) =>
          [...group].some(
            (binding) => !binding.internal && (scope === undefined || binding.scope === scope),
          ),
        )
        .map(([key, group]) => {
          const active = [...group].filter(
            (binding) => !binding.internal && (scope === undefined || binding.scope === scope),
          );
          return {
            key,
            pluginId: active[0]!.pluginId,
            members: [
              ...new Set(
                active.flatMap((binding) =>
                  [...binding.members].filter(
                    (member): member is string => typeof member === "string",
                  ),
                ),
              ),
            ],
            bindings: active.length,
            enabled: active.some(bindingEnabled),
            lifecycle: active[0]!.lifecycle,
            scopes: [...new Set(active.map((binding) => binding.scope))],
          };
        }),
    stage: Effect.fn("PluginKernel.stage")(
      (
        pluginId: string,
        contributions: ReadonlyArray<PluginServiceContribution>,
        retain?: Effect.Effect<Effect.Effect<void>>,
        namespace = pluginId,
      ) =>
        checked(
          Effect.uninterruptibleMask((restore) =>
            Effect.gen(function* () {
              const stage: ContributionStage = {
                pluginId,
                namespace,
                contributions,
                retain,
                installed: new Map(),
                definitions: [],
              };
              const fallbacks: Array<{
                readonly binding: Binding;
                readonly generation: Generation;
              }> = [];
              const prepared = yield* restore(
                checked(
                  Effect.gen(function* () {
                    const stagedDefinitions = new Map<string, Binding>();
                    for (const contribution of contributions)
                      if (contribution.kind === "register") {
                        if (
                          !contribution.key.startsWith(`${namespace}.`) &&
                          !contribution.key.startsWith(`${namespace}/`)
                        )
                          throw new Error("New plugin services must use their owner's namespace.");
                        const definitionKey = `${contribution.scope ?? "host"}:${contribution.key}`;
                        if (stagedDefinitions.has(definitionKey))
                          throw new Error(`Duplicate plugin service '${contribution.key}'.`);
                        if (
                          [...(bindings.get(contribution.key) ?? [])].some(
                            (binding) => binding.pluginId !== namespace,
                          )
                        )
                          throw new Error(
                            `Plugin service '${contribution.key}' already belongs to another owner.`,
                          );
                        const scope = yield* Scope.make();
                        const factoryContext: PluginServiceFactoryContext = {
                          scope: contribution.scope ?? "host",
                          original: undefined,
                          Effect,
                          Stream,
                          Scope,
                          services: {
                            get: (key) => {
                              const staged = stagedDefinitions.get(
                                `${contribution.scope ?? "host"}:${key}`,
                              );
                              return staged ? staged.facade : get(key, contribution.scope);
                            },
                            getBuiltin: (key) => {
                              const staged = stagedDefinitions.get(
                                `${contribution.scope ?? "host"}:${key}`,
                              );
                              return staged
                                ? staged.original?.value
                                : getBuiltin(key, contribution.scope);
                            },
                          },
                        };
                        const factory = Effect.try({
                          try: () => contribution.factory(factoryContext),
                          catch: error,
                        }).pipe(Effect.flatMap(toEffect));
                        yield* register(namespace, contribution.key, factory, {
                          deferred: true,
                          retain,
                          onCreated: (binding) => {
                            stagedDefinitions.set(definitionKey, binding);
                            stage.definitions.push({ binding, scope });
                          },
                        }).pipe(
                          Effect.provideService(Scope.Scope, scope),
                          Effect.provideService(PluginBindingScope, contribution.scope ?? "host"),
                        );
                      }
                    for (const contribution of contributions) {
                      if (
                        ![...(bindings.get(contribution.key) ?? [])].some(
                          (binding) => !binding.internal,
                        ) &&
                        !stage.definitions.some(
                          (definition) => definition.binding.key === contribution.key,
                        )
                      )
                        throw new Error(`Unknown plugin service '${contribution.key}'.`);
                    }
                    const targets = [...bindings.values()]
                      .flatMap((group) => [...group])
                      .filter((binding) => !binding.internal)
                      .concat(stage.definitions.map((definition) => definition.binding));
                    for (const binding of targets) {
                      if (
                        contributions.some(
                          (contribution) =>
                            contribution.key === binding.key &&
                            (contribution.scope === undefined ||
                              contribution.scope === binding.scope),
                        )
                      )
                        stage.installed.set(binding, yield* prepare(stage, binding));
                    }
                    const previous = stages.get(pluginId);
                    for (const [binding, installed] of previous?.installed ?? [])
                      if (
                        installed.replacement &&
                        binding.lifecycle &&
                        !binding.original &&
                        !stage.installed.get(binding)?.replacement &&
                        bindingEnabled(binding) &&
                        ![...binding.replacements].some(([owner]) => owner !== pluginId)
                      )
                        fallbacks.push({
                          binding,
                          generation: yield* build(binding.pluginId, binding.factory),
                        });
                  }),
                ),
              ).pipe(Effect.exit);
              if (Exit.isFailure(prepared)) {
                yield* disposeStage(stage);
                for (const { generation } of fallbacks) yield* retire(generation);
                return yield* Effect.failCause(prepared.cause);
              }
              const previous = stages.get(pluginId);
              stages.set(pluginId, stage);
              for (const { binding, generation } of fallbacks) binding.original = generation;
              for (const definition of stage.definitions) {
                const group = bindings.get(definition.binding.key) ?? new Set<Binding>();
                for (const existing of group)
                  if (
                    existing.forwardable &&
                    existing.scope === definition.binding.scope &&
                    existing.pluginId === namespace
                  )
                    existing.forward = definition.binding;
                definition.binding.group = group;
                group.add(definition.binding);
                bindings.set(definition.binding.key, group);
              }
              for (const [binding, installed] of stage.installed) {
                // Clear previous contributions from this owner, including members removed in a reload.
                binding.replacements.delete(pluginId);
                binding.wrappers.delete(pluginId);
                publishBinding(stage, binding, installed);
              }
              if (previous) {
                // Admission changes atomically. Slow extension cleanup must not turn
                // an already-published generation into a failed activation without a disposer.
                for (const [binding, installed] of previous.installed) {
                  if (binding.replacements.get(pluginId) === installed.replacement)
                    binding.replacements.delete(pluginId);
                  if (binding.wrappers.get(pluginId) === installed.wrappers)
                    binding.wrappers.delete(pluginId);
                  if (installed.replacement) installed.replacement.retired = true;
                  for (const wrapper of installed.wrappers) wrapper.generation.retired = true;
                }
                for (const { binding } of previous.definitions) {
                  binding.group.delete(binding);
                  if (binding.group.size === 0 && bindings.get(binding.key) === binding.group)
                    bindings.delete(binding.key);
                  if (binding.original) binding.original.retired = true;
                }
                yield* disposeStage(previous).pipe(Effect.interruptible, Effect.forkIn(rootScope));
              }
              for (const [binding, installed] of stage.installed)
                if (installed.replacement && binding.lifecycle && binding.original) {
                  const previousOriginal = binding.original;
                  binding.original = undefined;
                  previousOriginal.retired = true;
                  yield* retire(previousOriginal).pipe(
                    Effect.interruptible,
                    Effect.forkIn(rootScope),
                  );
                }
              return disposeStage(stage);
            }),
          ),
        ),
    ),
    setEnabled: Effect.fn("PluginKernel.setEnabled")(function* (
      pluginId: string,
      value: boolean,
      scope = "host",
    ) {
      const enabledKey = `${scope}:${pluginId}`;
      if (enabled.get(enabledKey) === value) return;
      if (value) {
        const previousEnabled = enabled.get(enabledKey);
        enabled.set(enabledKey, true);
        const rebuilt: Array<{
          binding: Binding;
          generation: Generation;
          members: ReadonlyArray<PropertyKey>;
        }> = [];
        const contributions: Array<{
          stage: ContributionStage;
          binding: Binding;
          prepared: {
            readonly replacement: Generation | undefined;
            readonly wrappers: ReadonlyArray<Wrapper>;
          };
        }> = [];
        const outcome = yield* checked(
          Effect.gen(function* () {
            for (const group of bindings.values())
              for (const binding of group)
                if (
                  binding.pluginId === pluginId &&
                  binding.scope === scope &&
                  !binding.original &&
                  !(binding.lifecycle && binding.replacements.size > 0)
                ) {
                  const generation = yield* build(pluginId, binding.factory);
                  binding.original = generation;
                  rebuilt.push({ binding, generation, members: [...binding.members] });
                  for (const member of memberKeys(generation.value)) binding.members.add(member);
                }
            for (const stage of stages.values())
              for (const group of bindings.values())
                for (const binding of group)
                  if (
                    binding.pluginId === pluginId &&
                    binding.scope === scope &&
                    stage.contributions.some(
                      (contribution) =>
                        contribution.key === binding.key &&
                        (contribution.scope === undefined || contribution.scope === scope),
                    )
                  )
                    contributions.push({
                      stage,
                      binding,
                      prepared: yield* prepare(stage, binding),
                    });
          }),
        ).pipe(Effect.exit);
        if (Exit.isFailure(outcome)) {
          if (previousEnabled === undefined) enabled.delete(enabledKey);
          else enabled.set(enabledKey, previousEnabled);
          for (const entry of contributions) {
            if (entry.prepared.replacement) yield* retire(entry.prepared.replacement);
            for (const wrapper of entry.prepared.wrappers) yield* retire(wrapper.generation);
          }
          for (const entry of backwards(rebuilt)) {
            entry.binding.original = undefined;
            entry.binding.members.clear();
            for (const member of entry.members) entry.binding.members.add(member);
            yield* retire(entry.generation);
            yield* close(entry.generation);
          }
          return yield* Effect.failCause(outcome.cause);
        }
        for (const { stage, binding, prepared } of contributions) {
          publishBinding(stage, binding, prepared);
          if (binding.lifecycle && prepared.replacement && binding.original) {
            const previousOriginal = binding.original;
            binding.original = undefined;
            yield* retire(previousOriginal);
          }
        }
      }
      enabled.set(enabledKey, value);
      if (!value)
        for (const binding of backwards([...bindings.values()].flatMap((group) => [...group])))
          if (binding.pluginId === pluginId && binding.scope === scope) {
            const original = binding.original;
            binding.original = undefined;
            for (const stage of stages.values()) {
              const installed = stage.installed.get(binding);
              if (!installed) continue;
              stage.installed.delete(binding);
              binding.replacements.delete(stage.pluginId);
              binding.wrappers.delete(stage.pluginId);
              if (installed.replacement) {
                yield* retire(installed.replacement);
                if (binding.lifecycle && !binding.resourceOwner)
                  yield* close(installed.replacement);
              }
              for (const wrapper of installed.wrappers) {
                yield* retire(wrapper.generation);
                if (binding.lifecycle && !binding.resourceOwner) yield* close(wrapper.generation);
              }
            }
            if (original) {
              yield* retire(original);
              if (binding.lifecycle && !binding.internal && !binding.resourceOwner)
                yield* close(original);
            }
          }
    }, checked),
  });
});

/** True for the error a disabled builtin's service throws when one of its members is used. */
export const isBuiltinDisabledError = (error: unknown, ...pluginIds: ReadonlyArray<string>) =>
  error instanceof Error && pluginIds.some((id) => error.message === `Plugin '${id}' is disabled.`);

/** True when every failure in the cause is a disabled builtin's service being used. */
export const isBuiltinDisabledCause = (
  cause: Cause.Cause<unknown>,
  ...pluginIds: ReadonlyArray<string>
) =>
  cause.reasons.length > 0 &&
  cause.reasons.every(
    (reason) => Cause.isDieReason(reason) && isBuiltinDisabledError(reason.defect, ...pluginIds),
  );

export const layerWithEnabled = (enabled: Readonly<Record<string, boolean>>) =>
  Layer.effect(PluginKernel, make(enabled));
export const layer = layerWithEnabled({});

export const builtinService = Effect.fn("builtinService")(function* <S, E, R>(
  pluginId: string,
  key: string,
  factory: Effect.Effect<S, E, R>,
  options?: { readonly lifecycle?: boolean },
): Effect.fn.Return<S, E, R | Scope.Scope> {
  const kernel = yield* Effect.serviceOption(PluginKernel);
  return Option.isSome(kernel)
    ? yield* kernel.value.registerBuiltin(pluginId, key, factory, options)
    : yield* factory;
});

/** The original Context tag and factory define the public service contract. */
export function builtinServiceLayer(pluginId: string): typeof Layer.effect;
export function builtinServiceLayer<I, S, E, R>(
  pluginId: string,
  service: Context.Key<I, S>,
  factory: Effect.Effect<Types.NoInfer<S>, E, R>,
): Layer.Layer<I, E, Exclude<R, Scope.Scope>>;
export function builtinServiceLayer(pluginId: string, ...args: ReadonlyArray<unknown>): unknown {
  if (args.length === 0)
    return (...serviceArgs: ReadonlyArray<unknown>) =>
      serviceArgs.length === 1
        ? (factory: Effect.Effect<unknown, unknown, unknown>) =>
            builtinServiceLayer(pluginId, serviceArgs[0] as Context.Key<unknown, unknown>, factory)
        : builtinServiceLayer(
            pluginId,
            serviceArgs[0] as Context.Key<unknown, unknown>,
            serviceArgs[1] as Effect.Effect<unknown, unknown, unknown>,
          );
  const service = args[0] as Context.Key<unknown, unknown>;
  return Layer.effect(
    service,
    builtinService(pluginId, service.key, args[1] as Effect.Effect<unknown, unknown, unknown>),
  );
}
export function builtinSucceedLayer(pluginId: string): typeof Layer.succeed;
export function builtinSucceedLayer<I, S>(
  pluginId: string,
  service: Context.Key<I, S>,
  value: Types.NoInfer<S>,
): Layer.Layer<I>;
export function builtinSucceedLayer(pluginId: string, ...args: ReadonlyArray<unknown>): unknown {
  if (args.length === 0)
    return (...serviceArgs: ReadonlyArray<unknown>) =>
      serviceArgs.length === 1
        ? (value: unknown) =>
            builtinSucceedLayer(pluginId, serviceArgs[0] as Context.Key<unknown, unknown>, value)
        : builtinSucceedLayer(
            pluginId,
            serviceArgs[0] as Context.Key<unknown, unknown>,
            serviceArgs[1],
          );
  return builtinServiceLayer(
    pluginId,
    args[0] as Context.Key<unknown, unknown>,
    Effect.succeed(args[1]),
  );
}
export const builtinSyncLayer = (pluginId: string): typeof Layer.sync => {
  const create = (...args: ReadonlyArray<unknown>) =>
    args.length === 1
      ? (evaluate: () => unknown) =>
          builtinServiceLayer(
            pluginId,
            args[0] as Context.Key<unknown, unknown>,
            Effect.sync(evaluate),
          )
      : builtinServiceLayer(
          pluginId,
          args[0] as Context.Key<unknown, unknown>,
          Effect.sync(args[1] as () => unknown),
        );
  return create as typeof Layer.sync;
};
/** Disposing the factory's scope stops the startup worker, with no fabricated public Context tag. */
export const builtinLifecycleLayer = <A, E, R>(
  pluginId: string,
  key: string,
  startup: Effect.Effect<A, E, R>,
): Layer.Layer<never, E, Exclude<R, Scope.Scope>> =>
  Layer.effectDiscard(
    builtinService(pluginId, key, startup.pipe(Effect.map((start) => ({ start }))), {
      lifecycle: true,
    }),
  );

/** Multi-service source factories still register each actual Context key separately. */
export const builtinContextLayer = <A, E, R>(
  pluginId: string,
  factory: Effect.Effect<Context.Context<A>, E, R>,
  outputKeys?: readonly string[],
): Layer.Layer<A, E, Exclude<R, Scope.Scope>> =>
  Layer.effectContext(
    Effect.gen(function* () {
      const kernel = yield* Effect.serviceOption(PluginKernel);
      if (Option.isNone(kernel)) return yield* factory;
      // The multi-output source factory owns one generation scope, including its startup effects.
      const original = yield* kernel.value.registerBuiltin(
        pluginId,
        `t3/runtime/${pluginId}/context`,
        factory,
        { internal: true },
      );
      const members = new Map<string, unknown>();
      // Known outputs let a disabled transport publish facades without starting its resources.
      for (const key of outputKeys ?? original.mapUnsafe.keys())
        members.set(
          key,
          yield* kernel.value.registerBuiltin(
            pluginId,
            key,
            Effect.sync(() => original.mapUnsafe.get(key)),
            { resourceOwner: original },
          ),
        );
      return Context.makeUnsafe<A>(members);
    }),
  );
