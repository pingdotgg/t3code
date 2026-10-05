import { Worker } from "@/Cloudflare/Workers/Worker.ts";
import type { Named, PlatformIdentity } from "@/index.ts";
import type { Platform, PlatformProps } from "@/Platform.ts";
import type { Resource } from "@/Resource.ts";
import type { BaseRuntimeContext } from "@/RuntimeContext.ts";
import * as Effect from "effect/Effect";

interface TestProps extends PlatformProps {
  env?: Record<string, string>;
}
interface TestResource extends Resource<
  "Test.PlatformIdentity",
  TestProps,
  {}
> {}

declare const TestPlatform: Platform<
  TestResource,
  never,
  { value: number },
  BaseRuntimeContext
>;

class ModularPlatform extends TestPlatform<
  ModularPlatform,
  { value: number }
>()("ModularPlatform") {}
class BarePlatform extends TestPlatform<BarePlatform>()("BarePlatform") {}
class InlinePlatform extends TestPlatform<InlinePlatform>()(
  "InlinePlatform",
  {},
  Effect.succeed({ value: 1 }),
) {}
class EffectPropsPlatform extends TestPlatform<EffectPropsPlatform>()(
  "EffectPropsPlatform",
  Effect.succeed({}),
  Effect.succeed({ value: 1 }),
) {}
const ExternalPlatform = TestPlatform("ExternalPlatform", {});
const ExternalEffectPlatform = TestPlatform(
  "ExternalEffectPlatform",
  Effect.succeed({}),
);
const FunctionalPlatform = TestPlatform(
  "FunctionalPlatform",
  {},
  Effect.succeed({ value: 1 }),
);
const FunctionalEffectPlatform = TestPlatform(
  "FunctionalEffectPlatform",
  Effect.succeed({}),
  Effect.succeed({ value: 1 }),
);

class ModularWorker extends Worker<ModularWorker, {}>()("ModularWorker") {}
class InlineWorker extends Worker<InlineWorker>()(
  "InlineWorker",
  {},
  Effect.succeed({}),
) {}
class EffectPropsWorker extends Worker<EffectPropsWorker>()(
  "EffectPropsWorker",
  Effect.succeed({}),
  Effect.succeed({}),
) {}
class ExternalWorker extends Worker<ExternalWorker>()("ExternalWorker", {}) {}
class ExternalEffectWorker extends Worker<ExternalEffectWorker>()(
  "ExternalEffectWorker",
  Effect.succeed({}),
) {}
const FunctionalWorker = Worker("FunctionalWorker", {}, Effect.succeed({}));
const ExternalFunctionalWorker = Worker("ExternalFunctionalWorker", {});
const ExternalFunctionalEffectWorker = Worker(
  "ExternalFunctionalEffectWorker",
  Effect.succeed({}),
);

const identity = <const Id extends string>(
  declaration: PlatformIdentity<Id>,
): Id => declaration.LogicalId;

const ids = {
  ModularPlatform: identity(ModularPlatform),
  BarePlatform: identity(BarePlatform),
  InlinePlatform: identity(InlinePlatform),
  EffectPropsPlatform: identity(EffectPropsPlatform),
  ExternalPlatform: identity(ExternalPlatform),
  ExternalEffectPlatform: identity(ExternalEffectPlatform),
  FunctionalPlatform: identity(FunctionalPlatform),
  FunctionalEffectPlatform: identity(FunctionalEffectPlatform),
  ModularWorker: identity(ModularWorker),
  InlineWorker: identity(InlineWorker),
  EffectPropsWorker: identity(EffectPropsWorker),
  ExternalWorker: identity(ExternalWorker),
  ExternalEffectWorker: identity(ExternalEffectWorker),
  FunctionalWorker: identity(FunctionalWorker),
  ExternalFunctionalWorker: identity(ExternalFunctionalWorker),
  ExternalFunctionalEffectWorker: identity(ExternalFunctionalEffectWorker),
};

type Assert<T extends true> = T;
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
type _LiteralIds = Assert<Equal<typeof ids, { [Id in keyof typeof ids]: Id }>>;

const modularLayer = ModularPlatform.make({}, Effect.succeed({ value: 1 }));
const bareLayer = BarePlatform.make({}, Effect.succeed({ value: 1 }));
const workerLayer = ModularWorker.make({}, Effect.succeed({}));
const providedPlatform = ModularPlatform.pipe(Effect.provide(modularLayer));
const providedBarePlatform = BarePlatform.pipe(Effect.provide(bareLayer));
const providedWorker = ModularWorker.pipe(Effect.provide(workerLayer));
type _ProvidedPlatform = Assert<
  Effect.Success<typeof providedPlatform> extends TestResource ? true : false
>;
type _ProvidedBarePlatform = Assert<
  Effect.Success<typeof providedBarePlatform> extends TestResource
    ? true
    : false
>;
type _ProvidedWorker = Assert<
  Effect.Success<typeof providedWorker> extends Worker ? true : false
>;

// Existing explicit type arguments still describe props requirements and bindings.
TestPlatform<never>("ExplicitPlatform", {});
Worker<{ TOKEN: string }>("ExplicitWorker", { env: { TOKEN: "token" } });

declare const dynamicId: string;
const DynamicPlatform = TestPlatform(dynamicId, {});
const DynamicWorker = Worker(dynamicId, {});
const DynamicInlinePlatform = TestPlatform(
  dynamicId,
  {},
  Effect.succeed({ value: 1 }),
);
const DynamicInlineWorker = Worker(dynamicId, {}, Effect.succeed({}));
class DynamicPlatformClass extends TestPlatform<DynamicPlatformClass>()(
  dynamicId,
) {}
class DynamicWorkerClass extends Worker<DynamicWorkerClass>()(dynamicId, {}) {}
type _DynamicIds = Assert<
  Equal<
    [
      typeof DynamicPlatform.LogicalId,
      typeof DynamicWorker.LogicalId,
      typeof DynamicInlinePlatform.LogicalId,
      typeof DynamicInlineWorker.LogicalId,
      typeof DynamicPlatformClass.LogicalId,
      typeof DynamicWorkerClass.LogicalId,
    ],
    [string, string, string, string, string, string]
  >
>;

// @ts-expect-error The static identity must retain its literal, not another id.
const wrongId: "Other" = ExternalWorker.LogicalId;
// @ts-expect-error Identity is readonly on class declarations.
InlineWorker.LogicalId = "InlineWorker";
// @ts-expect-error Identity is readonly on functional declarations.
ExternalPlatform.LogicalId = "ExternalPlatform";

declare const named: Named<"Phantom">;
// @ts-expect-error Named is only a phantom brand, not a native identity contract.
identity(named);
// @ts-expect-error The unbound platform factory declares no resource identity.
identity(TestPlatform);
// @ts-expect-error The unbound Worker factory declares no resource identity.
identity(Worker);
// @ts-expect-error A provided Effect is not itself a platform declaration.
identity(providedPlatform);

const shape = ModularPlatform.of({ value: 1 });
// @ts-expect-error of returns an implementation shape, not a declaration.
identity(shape);

declare const modularPlatform: ModularPlatform;
declare const barePlatform: BarePlatform;
declare const inlinePlatform: InlinePlatform;
// @ts-expect-error Static identity is not part of the implementation shape.
modularPlatform.LogicalId;
// @ts-expect-error A bare platform instance carries only phantom brands.
barePlatform.LogicalId;
// @ts-expect-error Inline implementation fields do not include static identity.
inlinePlatform.LogicalId;

// Worker shapes inherit MainRpc's string index signature through MakeShape.
// A possible RPC member named LogicalId is not declaration identity.
declare const modularWorker: ModularWorker;
declare const inlineWorker: InlineWorker;
// @ts-expect-error Worker implementation instances are not declarations.
identity(modularWorker);
// @ts-expect-error Inline Worker implementations are not declarations.
identity(inlineWorker);
const workerShape = ModularWorker.of({});
// @ts-expect-error of returns an implementation shape, not a declaration.
identity(workerShape);
// Yielded external Workers retain the resource's existing string identity.
type _ExternalResourceIds = Assert<
  Equal<
    [
      Effect.Success<typeof ExternalWorker>["LogicalId"],
      Effect.Success<typeof ExternalEffectWorker>["LogicalId"],
      Effect.Success<typeof ExternalFunctionalWorker>["LogicalId"],
    ],
    [string, string, string]
  >
>;
type _NamedInstances = Assert<
  ModularPlatform extends Named<"ModularPlatform">
    ? ExternalWorker extends Named<"ExternalWorker">
      ? true
      : false
    : false
>;
