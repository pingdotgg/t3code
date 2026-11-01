import { normalizeTransferredFrom } from "@/Cloudflare/Workers/DurableObject.ts";
import { Worker } from "@/Cloudflare/Workers/Worker.ts";
import {
  Platform,
  type PlatformIdentity,
  type PlatformProps,
} from "@/Platform.ts";
import type { Resource } from "@/Resource.ts";
import type { BaseRuntimeContext } from "@/RuntimeContext.ts";
import { expect, test } from "alchemy-test";
import * as Effect from "effect/Effect";

interface TestProps extends PlatformProps {
  env?: Record<string, string>;
}
interface TestResource extends Resource<
  "Test.PlatformIdentity",
  TestProps,
  {}
> {}

const identity = <const Id extends string>(
  declaration: PlatformIdentity<Id>,
): Id => declaration.LogicalId;

test(
  "Platform declarations expose their logical id without evaluating effects",
  () => {
    const TestPlatform: Platform<TestResource, never, {}, BaseRuntimeContext> =
      Platform<TestResource>("Test.PlatformIdentity", {
        createRuntimeContext: () => {
          throw new Error("Reading identity must not create a runtime context");
        },
      });
    const props = Effect.sync(() => {
      throw new Error("Reading identity must not evaluate props");
    });
    const impl = Effect.sync(() => {
      throw new Error("Reading identity must not evaluate the implementation");
    });

    class Modular extends TestPlatform<Modular, {}>()("Modular") {}
    class Bare extends TestPlatform<Bare>()("Bare") {}
    class Inline extends TestPlatform<Inline>()("Inline", {}, impl) {}
    class EffectProps extends TestPlatform<EffectProps>()(
      "EffectProps",
      props,
      impl,
    ) {}
    const External = TestPlatform("External", {});
    const ExternalEffect = TestPlatform("ExternalEffect", props);
    const Functional = TestPlatform("Functional", {}, impl);
    const FunctionalEffect = TestPlatform("FunctionalEffect", props, impl);

    Modular.make(props, impl);
    Bare.make(props, impl);

    for (const [id, declaration] of Object.entries({
      Modular,
      Bare,
      Inline,
      EffectProps,
      External,
      ExternalEffect,
      Functional,
      FunctionalEffect,
    })) {
      expect(identity(declaration)).toBe(id);
      expect(Effect.isEffect(declaration)).toBe(true);
    }
    expect(Modular.of({})).not.toHaveProperty("LogicalId");
    expect(TestPlatform).not.toHaveProperty("LogicalId");
  },
  { tags: ["unit", "local"] },
);

test(
  "ordinary Worker declarations retain logical ids before yielding",
  () => {
    const props = Effect.sync(() => {
      throw new Error("Reading identity must not evaluate Worker props");
    });
    const impl = Effect.sync(() => {
      throw new Error(
        "Reading identity must not evaluate Worker implementation",
      );
    });

    class Modular extends Worker<Modular, {}>()("Modular") {}
    class Inline extends Worker<Inline>()("Inline", {}, impl) {}
    class EffectProps extends Worker<EffectProps>()(
      "EffectProps",
      props,
      impl,
    ) {}
    class External extends Worker<External>()("External", {}) {}
    class ExternalEffect extends Worker<ExternalEffect>()(
      "ExternalEffect",
      props,
    ) {}
    const Functional = Worker("Functional", {}, impl);
    const ExternalFunctional = Worker("ExternalFunctional", {});
    const ExternalFunctionalEffect = Worker("ExternalFunctionalEffect", props);

    Modular.make(props, impl);

    for (const [id, declaration] of Object.entries({
      Modular,
      Inline,
      EffectProps,
      External,
      ExternalEffect,
      Functional,
      ExternalFunctional,
      ExternalFunctionalEffect,
    })) {
      expect(identity(declaration)).toBe(id);
      expect(Effect.isEffect(declaration)).toBe(true);
      expect(normalizeTransferredFrom(declaration)).toEqual([id]);
    }
    expect(Modular.of({})).not.toHaveProperty("LogicalId");
    expect(Worker).not.toHaveProperty("LogicalId");
  },
  {
    tags: [
      "unit",
      "provider:cloudflare",
      "provider:cloudflare:worker",
      "local",
    ],
  },
);
