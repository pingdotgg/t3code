import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Stream from "effect/Stream";
import type { Artifacts } from "./Artifacts.ts";
import type { ScopedPlanStatusSession } from "./Cli/Cli.ts";
import type { Diff } from "./Diff.ts";
import type { Input } from "./Input.ts";
import type { InstanceId } from "./InstanceId.ts";
import type { Platform } from "./Platform.ts";
import type {
  ResourceBinding,
  ResourceClass,
  ResourceClassLike,
  ResourceLike,
} from "./Resource.ts";

export interface Provider<
  R extends ResourceLike = ResourceLike,
> extends Effect.Effect<ProviderService<R>, never, Provider<R>> {
  asEffect: () => Effect.Effect<ProviderService<R>, never, Provider<R>>;
  [Symbol.iterator]: () => Effect.EffectIterator<Provider<R>>;
  of: <
    ReadReq = never,
    DiffReq = never,
    PrecreateReq = never,
    ReconcileReq = never,
    DeleteReq = never,
    TailReq = never,
    LogsReq = never,
    ListReq = never,
  >(
    service: Omit<
      ProviderService<
        R,
        ReadReq,
        DiffReq,
        PrecreateReq,
        ReconcileReq,
        DeleteReq,
        TailReq,
        LogsReq,
        ListReq
      >,
      "Type"
    >,
  ) => ProviderService<
    R,
    ReadReq,
    DiffReq,
    PrecreateReq,
    ReconcileReq,
    DeleteReq,
    TailReq,
    LogsReq,
    ListReq
  >;
}

type LifecycleServices = InstanceId | Artifacts;

export const Provider = <R extends ResourceLike>(
  type: R["Type"],
): Provider<R> =>
  Context.Service<Provider<R>, ProviderService<R>>()(type) as any;

type BindingData<Res extends ResourceLike> = [Res] extends [
  { Binding: infer B },
]
  ? ResourceBinding<B>[]
  : any[];

type Props<Res extends ResourceLike> = keyof Res["Props"] extends never
  ? Res["Props"] | undefined
  : Res["Props"];

export interface LogLine {
  timestamp: Date;
  message: string;
}

export interface LogsInput {
  since?: Date;
  limit?: number;
}

export interface ProviderService<
  Res extends ResourceLike = ResourceLike,
  ReadReq = never,
  DiffReq = never,
  PrecreateReq = never,
  ReconcileReq = never,
  DeleteReq = never,
  TailReq = never,
  LogsReq = never,
  ListReq = never,
> {
  /**
   * The version of the provider.
   *
   * @default 0
   */
  version?: number;
  /**
   * Legacy type names this provider also answers to. Copied from the
   * resource class's `aliases` option by {@link succeed}/{@link effect} so
   * state persisted under a pre-rename type (e.g. `"Cloudflare.Queue"`
   * before the `"Cloudflare.Queues.Queue"` rename) still resolves to this
   * provider via {@link tryFindProviderByType}.
   */
  aliases?: readonly string[];
  /**
   * Account-wide teardown (`alchemy unsafe nuke`) behaviour. Providers whose
   * resources can't meaningfully be deleted opt out here so nuke doesn't
   * report an endless "deleted but still there" loop. `read`/import are
   * unaffected.
   */
  nuke?: {
    /**
     * The resource is an account/zone **singleton setting** — always-present
     * configuration (e.g. Bot Management, Email Routing, a zone's SSL
     * settings) whose `delete` only *resets* it to defaults rather than
     * removing a discrete resource. Skipped by nuke, since `list` always
     * re-enumerates it and "deleting" it just resets config the operator
     * never created.
     */
    singleton?: boolean;
    /**
     * The resource is skipped by nuke for any other reason — typically because
     * it can never actually be deleted (no delete API, like RealtimeKit Apps;
     * or a registration that is never released, like Registrar Domains). Unlike
     * {@link singleton}, these are ordinary multi-instance resources.
     */
    skip?: boolean;
    /**
     * Provider IDs (picomatch globs, e.g. `"AWS.IAM.Role"` or `"AWS.EC2.*"`)
     * whose resources this type's **cloud-side teardown** consumes — they
     * must still exist while this type is deleting. `alchemy unsafe nuke`
     * topologically orders deletion so every resource of this type is fully
     * gone before any matching type starts deleting; if this type's deletes
     * fail, the matching types are held back rather than deleted out from
     * under an in-flight teardown.
     *
     * Example: SageMaker HyperPod deletes node ENIs by assuming the
     * instance group's execution role — deleting the role (or the VPC)
     * mid-teardown wedges the cluster in `Deleting` permanently, so
     * `AWS.SageMaker.Cluster` declares `dependsOn: ["AWS.IAM.Role", ...]`.
     *
     * The constraint only takes effect when resources of this type are
     * actually present in the nuke target set; declaration cycles collapse
     * into a single concurrent wave (with a logged warning) instead of
     * failing.
     */
    dependsOn?: readonly string[];
  };
  /**
   * Enumerates every existing resource of this type in the ambient scope
   * (account / region / zone resolved from the environment services), and
   * returns the full {@link ProviderService} `Attributes` shape for each —
   * the same shape {@link read} produces, so each item is directly usable
   * with {@link delete} without a follow-up read.
   *
   * This powers account-wide operations such as `alchemy nuke`, which lists
   * everything and then deletes it. It takes no input and must paginate
   * exhaustively so the returned array is complete.
   *
   * Resources with no native enumeration API (account/zone singletons,
   * existence-only resources, sub-resources keyed entirely by a parent)
   * should return an empty array rather than throwing.
   */
  list(): Effect.Effect<Res["Attributes"][], any, ListReq>;
  /**
   * Returns a stream of log lines for a deployed resource.
   * Used by `alchemy tail` to stream real-time logs.
   */
  tail?(input: {
    id: string;
    /**
     * Fully-qualified name (namespace path + logical id, see `./FQN.ts`) —
     * globally unique, so providers can stamp ownership metadata on cloud objects.
     */
    fqn: string;
    instanceId: string;
    props: Props<Res>;
    output: Res["Attributes"];
  }): Stream.Stream<LogLine, any, TailReq>;
  /**
   * Queries historical logs for a deployed resource.
   * Used by `alchemy logs` to fetch past log entries.
   */
  logs?(input: {
    id: string;
    /**
     * Fully-qualified name (namespace path + logical id, see `./FQN.ts`) —
     * globally unique, so providers can stamp ownership metadata on cloud objects.
     */
    fqn: string;
    instanceId: string;
    props: Props<Res>;
    output: Res["Attributes"];
    options: LogsInput;
  }): Effect.Effect<LogLine[], any, LogsReq>;
  // watch();
  // replace(): Effect.Effect<void, never, never>;
  // different interface that is persistent, watching, reloads
  // run?() {}
  // branch?() {}
  read?(input: {
    id: string;
    /**
     * Fully-qualified name (namespace path + logical id, see `./FQN.ts`) —
     * globally unique, so providers can stamp ownership metadata on cloud objects.
     */
    fqn: string;
    instanceId: string;
    olds: Props<Res>;
    // what is the ARN?
    output: Res["Attributes"] | undefined; // current state -> synced state
  }): Effect.Effect<Res["Attributes"] | undefined, any, ReadReq>;
  /**
   * Properties that are always stable across any update.
   */
  stables?: Extract<keyof Res["Attributes"], string>[];
  diff?(input: {
    id: string;
    /**
     * Fully-qualified name (namespace path + logical id, see `./FQN.ts`) —
     * globally unique, so providers can stamp ownership metadata on cloud objects.
     */
    fqn: string;
    instanceId: string;
    olds: Props<Res>;
    // Note: we do not resolve (Res["Props"]) here because diff runs during plan
    // -> we need a way for the diff handlers to work with Outputs
    news: Input<Props<Res>>;
    oldBindings: BindingData<Res>;
    newBindings: Input<BindingData<Res>>;
    output: Res["Attributes"] | undefined;
  }): Effect.Effect<Diff | void, any, DiffReq>;
  // dev?:() => Effect.Effect<void, any, DevReq>;
  precreate?(input: {
    id: string;
    /**
     * Fully-qualified name (namespace path + logical id, see `./FQN.ts`) —
     * globally unique, so providers can stamp ownership metadata on cloud objects.
     */
    fqn: string;
    news: Props<Res>;
    instanceId: string;
    session: ScopedPlanStatusSession;
    bindings: BindingData<Res>;
  }): Effect.Effect<Res["Attributes"], any, PrecreateReq>;
  /**
   * Reconciles the desired state of a Resource with the live cloud state.
   *
   * This unified lifecycle method replaces the previous `create` and `update`
   * pair. The engine dispatches `reconcile` for both intents — initial
   * provisioning and subsequent updates — and providers must defensively
   * handle every combination of inputs:
   *
   * - `output === undefined` and `olds === undefined` — first reconciliation
   *   for this logical resource. Treat as a create. Must remain idempotent
   *   because state persistence can fail after a successful API call.
   * - `output !== undefined` and `olds === undefined` — engine adopted an
   *   existing cloud resource (via {@link read}). The provider has never
   *   written this resource through Alchemy before, so cannot rely on prior
   *   props as a baseline.
   * - `output !== undefined` and `olds !== undefined` — standard update
   *   path with a known prior state.
   *
   * Ownership has already been verified upstream — by the time `reconcile`
   * runs, the engine has confirmed (via `read` returning a non-`Unowned`
   * value, or by writing the resource itself) that mutation is safe.
   */
  reconcile(input: {
    id: string;
    /**
     * Fully-qualified name (namespace path + logical id, see `./FQN.ts`) —
     * globally unique, so providers can stamp ownership metadata on cloud objects.
     */
    fqn: string;
    instanceId: string;
    news: Props<Res>;
    olds: Props<Res> | undefined;
    output: Res["Attributes"] | undefined;
    session: ScopedPlanStatusSession;
    bindings: BindingData<Res>;
  }): Effect.Effect<Res["Attributes"], any, ReconcileReq>;
  delete(input: {
    id: string;
    /**
     * Fully-qualified name (namespace path + logical id, see `./FQN.ts`) —
     * globally unique, so providers can stamp ownership metadata on cloud objects.
     */
    fqn: string;
    instanceId: string;
    olds: Props<Res>;
    output: Res["Attributes"];
    session: ScopedPlanStatusSession;
    bindings: BindingData<Res>;
    /**
     * Set by account-wide teardown (`alchemy unsafe nuke`) to signal the
     * operator explicitly requested destructive deletion. Nuke enumerates
     * resources straight from the cloud, so `olds` carries Attributes rather
     * than the originally-deployed Props — destructive prerequisites that a
     * normal destroy gates behind a prop (e.g. emptying a non-empty S3
     * bucket behind `forceDestroy`) may be performed when this is set.
     * Normal engine destroys never set it.
     */
    force?: boolean;
  }): Effect.Effect<void, any, DeleteReq>;
}

export const effect = <
  R extends ResourceLike,
  Req = never,
  ReadReq = never,
  DiffReq = never,
  PrecreateReq = never,
  ReconcileReq = never,
  DeleteReq = never,
  TailReq = never,
  LogsReq = never,
  ListReq = never,
>(
  cls: ResourceClassLike<R> | Platform<R, any, any, any, any>,
  eff: Effect.Effect<
    ProviderService<
      R,
      ReadReq,
      DiffReq,
      PrecreateReq,
      ReconcileReq,
      DeleteReq,
      TailReq,
      LogsReq,
      ListReq
    >,
    never,
    Req
  >,
): Layer.Layer<
  Provider<R>,
  never,
  Exclude<
    Req | ReadReq | DiffReq | PrecreateReq | ReconcileReq | DeleteReq | ListReq,
    LifecycleServices
  >
> =>
  Layer.effect(
    // @ts-expect-error
    Provider(cls.Type),
    Effect.map(eff, (service) => ({
      aliases: "Aliases" in cls ? cls.Aliases : undefined,
      ...service,
    })),
  ) as any;

export const succeed = <
  R extends ResourceLike,
  ReadReq = never,
  DiffReq = never,
  PrecreateReq = never,
  ReconcileReq = never,
  DeleteReq = never,
  TailReq = never,
  LogsReq = never,
  ListReq = never,
>(
  cls: ResourceClass<R> | Platform<R, any, any, any, any>,
  service: ProviderService<
    R,
    ReadReq,
    DiffReq,
    PrecreateReq,
    ReconcileReq,
    DeleteReq,
    TailReq,
    LogsReq,
    ListReq
  >,
): Layer.Layer<
  Provider<R>,
  never,
  Exclude<
    ReadReq | DiffReq | PrecreateReq | ReconcileReq | DeleteReq | ListReq,
    LifecycleServices
  >
> =>
  // @ts-expect-error
  Layer.succeed(Provider(cls.Type), {
    aliases: "Aliases" in cls ? cls.Aliases : undefined,
    ...service,
  });

export interface ProviderCollectionLike {
  kind: "ProviderCollection";
}

export interface ProviderCollectionShape<Identifier extends string>
  extends
    Context.ServiceClass.Shape<Identifier, ProviderCollectionService>,
    ProviderCollectionLike {}

export interface ProviderCollection<Self, Identifier extends string>
  extends
    Context.Service<Self, ProviderCollectionService>,
    ProviderCollectionLike {
  readonly key: Identifier;
  new (_: never): ProviderCollectionShape<Identifier>;
}

export const ProviderCollection =
  <Self>() =>
  <const ProviderId extends string>(id: ProviderId) =>
    Context.Service<Self, ProviderCollectionService>()(
      id,
    ) as ProviderCollection<Self, ProviderId>;

export interface ProviderCollectionService {
  kind: "ProviderCollection";
  get<Resource extends ResourceLike>(
    service: string,
  ): ProviderService<Resource> | undefined;
  /**
   * Every provider in this collection keyed by its resource type
   * (e.g. `"Cloudflare.Worker"`). Used by account-wide operations such
   * as `alchemy unsafe nuke` to enumerate and filter providers — the
   * collection's closure-captured map would otherwise be unreachable.
   */
  readonly providers: Record<string, ProviderService>;
}

export const collection = <
  R extends ResourceClassLike<any> | Platform<any, any, any, any, any>,
>(
  resources: R[],
): Effect.Effect<
  ProviderCollectionService,
  never,
  R extends ResourceClass<infer R> | Platform<infer R, any, any, any, any>
    ? Provider<R>
    : never
> =>
  Effect.gen(function* () {
    const context = yield* Effect.context();

    const providers = Object.fromEntries(
      yield* Effect.all(
        resources.map((resource) =>
          "Provider" in resource
            ? resource.Provider.pipe(
                Effect.map((provider) => [resource.Type, provider] as const),
              )
            : Effect.succeed([
                (resource as { key: string }).key,
                context.mapUnsafe.get((resource as { key: string }).key),
              ] as const),
        ),
        { concurrency: "unbounded" },
      ),
    );

    return {
      kind: "ProviderCollection" as const,
      get: (service: string) => providers[service],
      providers,
    };
  }) as any;

const isProviderCollectionService = (
  value: unknown,
): value is ProviderCollectionService => {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    value.kind === "ProviderCollection"
  );
};

/**
 * Structural check for a {@link ProviderService} living in the Effect
 * context. Providers are keyed by their canonical resource type; when
 * searching for a legacy alias, the tag key won't match, so lookup has to
 * recognize provider services by shape.
 */
const isProviderService = (value: unknown): value is ProviderService =>
  typeof value === "object" &&
  value !== null &&
  "reconcile" in value &&
  typeof (value as ProviderService).reconcile === "function" &&
  "delete" in value &&
  typeof (value as ProviderService).delete === "function";

export const findProviderByType: {
  <R extends ResourceLike>(
    resourceType: R["Type"],
  ): Effect.Effect<ProviderService<R>>;
} = ((type: string) =>
  tryFindProviderByType(type).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.die(`Provider not found for ${type}`),
        onSome: (provider) => Effect.succeed(provider),
      }),
    ),
  )) as any;

/**
 * Typed provider lookup by resource class (or {@link Platform}) value. Infers
 * `R` from the class so `provider.list()` / `provider.read(...)` return the
 * resource's `Attributes` shape — prefer this over {@link findProviderByType},
 * which only takes the type string.
 */
export const findProvider: {
  <R extends ResourceLike>(
    resource: ResourceClassLike<R> | Platform<R, any, any, any, any>,
  ): Effect.Effect<ProviderService<R>>;
} = (resource: { Type?: string; key?: string }) =>
  findProviderByType((resource.Type ?? resource.key) as string) as any;

/**
 * A persisted state row references a resource type with no registered
 * provider — the type was removed from the program (or renamed without an
 * alias) while its state row still exists ("zombie" row).
 *
 * This is FATAL at plan time: the program and state fundamentally disagree,
 * and without the provider the row's physical resource cannot be deleted
 * anyway, so proceeding would only strand it silently. The plan dies with
 * this error; nothing is deployed or destroyed until the provider is
 * re-registered (or aliased), or the state row is cleared manually.
 */
export class MissingProviderError extends Data.TaggedError(
  "MissingProviderError",
)<{
  message: string;
  resourceType: string;
  fqn: string;
}> {}

/** Build the fatal plan-time error for a zombie state row. */
export const missingProviderError = (
  resourceType: string,
  fqn: string,
): MissingProviderError =>
  new MissingProviderError({
    message:
      `No provider is registered for resource type '${resourceType}' ` +
      `(state row '${fqn}'). The type was removed from the program or ` +
      "renamed without an alias. Re-register the provider (or add the " +
      "old name to the resource's `aliases`) so this row can be " +
      "destroyed, or clear the state row manually if the physical " +
      "resource is already gone.",
    resourceType,
    fqn,
  });

export const tryFindProviderByType: {
  <R extends ResourceLike>(
    resourceType: R["Type"],
  ): Effect.Effect<Option.Option<ProviderService<R>>>;
} = Effect.fn(function* <R extends ResourceLike>(resourceType: R["Type"]) {
  const Tag = Provider<R>(resourceType) as unknown as Context.Service<
    Provider<R>,
    any
  >;
  const direct = yield* Effect.serviceOption(Tag);
  if (Option.isSome(direct)) {
    return direct;
  }

  const context = yield* Effect.context<never>();
  for (const value of context.mapUnsafe.values()) {
    if (isProviderCollectionService(value)) {
      const provider = value.get(resourceType);
      if (provider) {
        return Option.some(provider);
      }
    }
  }

  // State persisted before a type rename carries the legacy name, so no
  // provider is keyed under it. Fall back to a provider that declares the
  // name in its `aliases` — scanning both bare Provider layers and the
  // members of every ProviderCollection.
  for (const value of context.mapUnsafe.values()) {
    if (isProviderCollectionService(value)) {
      for (const provider of Object.values(value.providers)) {
        if (provider.aliases?.includes(resourceType)) {
          return Option.some(provider);
        }
      }
    } else if (
      isProviderService(value) &&
      value.aliases?.includes(resourceType)
    ) {
      return Option.some(value);
    }
  }
  return Option.none();
}) as any;
