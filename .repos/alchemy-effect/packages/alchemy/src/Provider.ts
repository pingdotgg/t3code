import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Stream from "effect/Stream";
import type { Artifacts } from "./Artifacts.ts";
import type { Policy } from "./Binding.ts";
import type { ScopedPlanStatusSession } from "./Cli/Cli.ts";
import type { Diff } from "./Diff.ts";
import type { Input } from "./Input.ts";
import type { InstanceId } from "./InstanceId.ts";
import type { Platform } from "./Platform.ts";
import type {
  ResourceBinding,
  ResourceClass,
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
        LogsReq
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
    LogsReq
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
> {
  /**
   * The version of the provider.
   *
   * @default 0
   */
  version?: number;
  /**
   * Returns a stream of log lines for a deployed resource.
   * Used by `alchemy tail` to stream real-time logs.
   */
  tail?(input: {
    id: string;
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
    instanceId: string;
    news: Props<Res>;
    olds: Props<Res> | undefined;
    output: Res["Attributes"] | undefined;
    session: ScopedPlanStatusSession;
    bindings: BindingData<Res>;
  }): Effect.Effect<Res["Attributes"], any, ReconcileReq>;
  delete(input: {
    id: string;
    instanceId: string;
    olds: Props<Res>;
    output: Res["Attributes"];
    session: ScopedPlanStatusSession;
    bindings: BindingData<Res>;
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
>(
  cls: ResourceClass<R> | Platform<R, any, any, any, any>,
  eff: Effect.Effect<
    ProviderService<
      R,
      ReadReq,
      DiffReq,
      PrecreateReq,
      ReconcileReq,
      DeleteReq,
      TailReq,
      LogsReq
    >,
    never,
    Req
  >,
): Layer.Layer<
  Provider<R>,
  never,
  Exclude<
    Req | ReadReq | DiffReq | PrecreateReq | ReconcileReq | DeleteReq,
    LifecycleServices
  >
> =>
  // @ts-expect-error
  Layer.effect(Provider(cls.Type), eff);

export const succeed = <
  R extends ResourceLike,
  ReadReq = never,
  DiffReq = never,
  PrecreateReq = never,
  ReconcileReq = never,
  DeleteReq = never,
  TailReq = never,
  LogsReq = never,
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
    LogsReq
  >,
): Layer.Layer<
  Provider<R>,
  never,
  Exclude<
    ReadReq | DiffReq | PrecreateReq | ReconcileReq | DeleteReq,
    LifecycleServices
  >
> =>
  // @ts-expect-error
  Layer.succeed(Provider(cls.Type), service);

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
}

export const collection = <
  R extends
    | ResourceClass<any>
    | Platform<any, any, any, any, any>
    | Policy<any, any, any>,
>(
  resources: R[],
): Effect.Effect<
  ProviderCollectionService,
  never,
  R extends ResourceClass<infer R> | Platform<infer R, any, any, any, any>
    ? Provider<R>
    : R extends Policy<infer Self, infer _I, infer _S>
      ? Self
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
                resource.key,
                context.mapUnsafe.get(resource.key),
              ] as const),
        ),
        { concurrency: "unbounded" },
      ),
    );

    return {
      kind: "ProviderCollection" as const,
      get: (service: string) => providers[service],
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

export const findProviderByType: {
  <R extends ResourceLike>(
    resourceType: R["Type"],
  ): Effect.Effect<ProviderService<R>>;
  <P extends Policy<any, any, any>>(
    policyType: P["key"],
  ): Effect.Effect<Effect.Success<P>>;
} = (type: string) =>
  tryFindProviderByType(type).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.die(`Provider not found for ${type}`),
        onSome: (provider) => Effect.succeed(provider),
      }),
    ),
  );

export const tryFindProviderByType: {
  <R extends ResourceLike>(
    resourceType: R["Type"],
  ): Effect.Effect<Option.Option<ProviderService<R>>>;
  <P extends Policy<any, any, any>>(
    policyType: P["key"],
  ): Effect.Effect<Option.Option<Effect.Success<P>>>;
} = Effect.fnUntraced(function* <R extends ResourceLike>(
  resourceType: R["Type"],
) {
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
  return Option.none();
}) as any;
