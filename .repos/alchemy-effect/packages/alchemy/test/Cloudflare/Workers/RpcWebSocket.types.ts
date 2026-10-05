import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SchemaGetter from "effect/SchemaGetter";
import {
  Rpc,
  RpcGroup,
  RpcMiddleware,
  RpcSerialization,
  RpcServer,
} from "effect/rpc";

class Dependency extends Context.Service<Dependency, string>()(
  "RpcSocketDependency",
) {}
class Api extends RpcGroup.make(Rpc.make("read", { success: Schema.String })) {}

const impl = Effect.gen(function* () {
  return Effect.gen(function* () {
    return Api.toLayer({ read: () => Dependency });
  });
});

class Inline extends Cloudflare.RpcDurableObject<Inline>()(
  "Inline",
  { schema: Api },
  impl,
) {}

class Modular extends Cloudflare.RpcDurableObject<Modular>()("Modular", {
  schema: Api,
}) {}

const bare = Cloudflare.RpcDurableObject("Bare", { schema: Api }, impl);
const live = Modular.make(impl);

const inlineRequirements: Effect.Effect<
  unknown,
  never,
  Cloudflare.Worker | Dependency
> = Inline;
const bareRequirements: Effect.Effect<
  unknown,
  never,
  Cloudflare.Worker | Dependency
> = bare;
const modularRequirements: Layer.Layer<
  Modular,
  never,
  Cloudflare.Worker | Dependency
> = live;

// @ts-expect-error Handler dependencies must remain required by the inline class.
const missingInline: Effect.Effect<unknown, never, Cloudflare.Worker> = Inline;
// @ts-expect-error Handler dependencies must remain required by the bare form.
const missingBare: Effect.Effect<unknown, never, Cloudflare.Worker> = bare;
// @ts-expect-error Handler dependencies must remain required by the modular layer.
const missingModular: Layer.Layer<Modular, never, Cloudflare.Worker> = live;

const mergedImpl = Effect.succeed(
  Effect.succeed(
    Layer.mergeAll(
      Api.toLayer({ read: () => Dependency }),
      Layer.succeed(Dependency, "sibling output"),
    ),
  ),
);

class MergedInline extends Cloudflare.RpcDurableObject<MergedInline>()(
  "MergedInline",
  { schema: Api },
  mergedImpl,
) {}
const mergedBare = Cloudflare.RpcDurableObject(
  "MergedBare",
  { schema: Api },
  mergedImpl,
);
const mergedLive = Modular.make(mergedImpl);

// @ts-expect-error Merged outputs do not supply sibling handler inputs.
const missingMergedInline: Effect.Effect<unknown, never, Cloudflare.Worker> =
  MergedInline;
// @ts-expect-error Merged outputs do not supply sibling handler inputs.
const missingMergedBare: Effect.Effect<unknown, never, Cloudflare.Worker> =
  mergedBare;
// @ts-expect-error Merged outputs do not supply sibling handler inputs.
const missingMergedModular: Layer.Layer<Modular, never, Cloudflare.Worker> =
  mergedLive;

const outerImpl = Effect.gen(function* () {
  const value = yield* Dependency;
  return Effect.succeed(
    Layer.mergeAll(
      Api.toLayer({ read: () => Effect.succeed(value) }),
      Layer.succeed(Dependency, "inner output"),
    ),
  );
});

class OuterInline extends Cloudflare.RpcDurableObject<OuterInline>()(
  "OuterInline",
  { schema: Api },
  outerImpl,
) {}
const outerBare = Cloudflare.RpcDurableObject(
  "OuterBare",
  { schema: Api },
  outerImpl,
);
const outerLive = Modular.make(outerImpl);

// @ts-expect-error Inner layer outputs cannot satisfy outer initialization.
const missingOuterInline: Effect.Effect<unknown, never, Cloudflare.Worker> =
  OuterInline;
// @ts-expect-error Inner layer outputs cannot satisfy outer initialization.
const missingOuterBare: Effect.Effect<unknown, never, Cloudflare.Worker> =
  outerBare;
// @ts-expect-error Inner layer outputs cannot satisfy outer initialization.
const missingOuterModular: Layer.Layer<Modular, never, Cloudflare.Worker> =
  outerLive;

const CodecString = Schema.String.pipe(
  Schema.decodeTo(Schema.String, {
    decode: SchemaGetter.passthrough<string>(),
    encode: SchemaGetter.transformEffect((value: string) =>
      Dependency.pipe(Effect.as(value)),
    ),
  }),
);
class CodecApi extends RpcGroup.make(
  Rpc.make("read", { success: CodecString }),
) {}
const codecImpl = Effect.succeed(
  Effect.succeed(
    Layer.mergeAll(
      CodecApi.toLayer({ read: () => Effect.succeed("value") }),
      Layer.succeed(Dependency, "codec output"),
    ),
  ),
);
class CodecInline extends Cloudflare.RpcDurableObject<CodecInline>()(
  "CodecInline",
  { schema: CodecApi },
  codecImpl,
) {}
class CodecModular extends Cloudflare.RpcDurableObject<CodecModular>()(
  "CodecModular",
  { schema: CodecApi },
) {}
const codecBare = Cloudflare.RpcDurableObject(
  "CodecBare",
  { schema: CodecApi },
  codecImpl,
);
const codecLive = CodecModular.make(codecImpl);

// @ts-expect-error Codecs use the handler's captured input context, not outputs.
const missingCodecInline: Effect.Effect<unknown, never, Cloudflare.Worker> =
  CodecInline;
// @ts-expect-error Codecs use the handler's captured input context, not outputs.
const missingCodecBare: Effect.Effect<unknown, never, Cloudflare.Worker> =
  codecBare;
// @ts-expect-error Codecs use the handler's captured input context, not outputs.
const missingCodecModular: Layer.Layer<CodecModular, never, Cloudflare.Worker> =
  codecLive;

class Middleware extends RpcMiddleware.Service<Middleware>()(
  "RpcSocketMiddleware",
) {}
const MiddlewareApi = Api.middleware(Middleware);
const middlewareImpl = Effect.succeed(
  Effect.succeed(
    Layer.mergeAll(
      MiddlewareApi.toLayer({ read: () => Effect.succeed("value") }),
      Layer.succeed(Middleware, (effect) => effect),
    ),
  ),
);
class MiddlewareInline extends Cloudflare.RpcDurableObject<MiddlewareInline>()(
  "MiddlewareInline",
  { schema: MiddlewareApi },
  middlewareImpl,
) {}
const middlewareRequirements: Effect.Effect<unknown, never, Cloudflare.Worker> =
  MiddlewareInline;

const dependencyEffects: ReadonlyArray<
  Effect.Effect<unknown, never, Cloudflare.Worker | Dependency>
> = [MergedInline, mergedBare, OuterInline, outerBare, CodecInline, codecBare];
const dependencyLayers: ReadonlyArray<
  Layer.Layer<never, never, Cloudflare.Worker | Dependency>
> = [mergedLive, outerLive, codecLive];

const legacyImpl = Effect.succeed(
  Effect.succeed(
    RpcServer.toHttpEffect(Api).pipe(
      Effect.provide(
        Layer.mergeAll(
          Api.toLayer({ read: () => Effect.succeed("legacy") }),
          RpcSerialization.layerNdjson,
        ),
      ),
    ),
  ),
);
class LegacyInline extends Cloudflare.RpcDurableObject<LegacyInline>()(
  "LegacyInline",
  { schema: Api },
  legacyImpl,
) {}
class LegacyModular extends Cloudflare.RpcDurableObject<LegacyModular>()(
  "LegacyModular",
  { schema: Api },
) {}
const legacyBare = Cloudflare.RpcDurableObject(
  "LegacyBare",
  { schema: Api },
  legacyImpl,
);
const legacyEffects: ReadonlyArray<
  Effect.Effect<unknown, never, Cloudflare.Worker>
> = [LegacyInline, legacyBare];
const legacyLive: Layer.Layer<LegacyModular, never, Cloudflare.Worker> =
  LegacyModular.make(legacyImpl);

void [
  inlineRequirements,
  bareRequirements,
  modularRequirements,
  missingInline,
  missingBare,
  missingModular,
  missingMergedInline,
  missingMergedBare,
  missingMergedModular,
  missingOuterInline,
  missingOuterBare,
  missingOuterModular,
  missingCodecInline,
  missingCodecBare,
  missingCodecModular,
  middlewareRequirements,
  dependencyEffects,
  dependencyLayers,
  legacyEffects,
  legacyLive,
];
