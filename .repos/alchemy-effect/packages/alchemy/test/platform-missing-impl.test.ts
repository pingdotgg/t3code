/**
 * A tagged platform resource declared as a bare tag — no props, no inline
 * impl — gets both from its `.make(props, impl)` Layer. Yielding it without
 * that Layer used to register the resource with `undefined` props, so the
 * failure surfaced much later as an opaque `TypeError` inside whichever
 * provider first read a prop (`news.name` in the Cloudflare Worker
 * pre-create). It must fail fast instead, naming the class and its Layer.
 *
 * The three neighbouring branches of `Platform.ts`'s tag handling must keep
 * working: tag + Layer provided, tag + props (external), plain non-tagged.
 */
import * as Alchemy from "@/index.ts";
import { Platform } from "@/Platform.ts";
import * as Provider from "@/Provider.ts";
import type { Resource } from "@/Resource.ts";
import { InMemoryService, State } from "@/State/index.ts";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";

interface Widget extends Resource<
  "Test.PlatformWidget",
  { name?: string; env?: Record<string, any>; exports?: string[] },
  { name: string },
  { env?: Record<string, any> }
> {}

const Widget: any = Platform<Widget>("Test.PlatformWidget", {
  createRuntimeContext: () => ({}) as any,
});

/** `Widget` is untyped (`Platform` returns `any`), so yields need a cast. */
const yieldWidget = (cls: unknown) => cls as Effect.Effect<{ name: string }>;

/** What the provider received as `news`, if it ran at all. */
let observed: { ran: boolean; news: unknown } = { ran: false, news: undefined };

const providers = Provider.succeed(Widget, {
  list: () => Effect.succeed([]),
  diff: Effect.fn(function* () {
    return undefined;
  }),
  reconcile: Effect.fn(function* ({ id, news }: any) {
    observed = { ran: true, news };
    return { name: news?.name ?? id };
  }),
  delete: Effect.fn(function* () {}),
});

const state = Layer.effect(
  State,
  Effect.sync(() => InMemoryService({})),
);

const { test, deploy } = Test.make({ providers, state });

const runDeploy = (stack: any) =>
  Effect.gen(function* () {
    observed = { ran: false, news: undefined };
    return yield* Effect.exit(deploy(stack) as Effect.Effect<any>);
  });

// A bare tag whose `.make(...)` Layer is deliberately never provided.
class BareWidget extends Widget()("BareWidget") {}

const MissingImplStack = Alchemy.Stack(
  "PlatformMissingImplStack",
  { providers, state },
  Effect.gen(function* () {
    const widget = yield* yieldWidget(BareWidget);
    return { name: widget.name };
  }),
);

class ProvidedWidget extends Widget()("ProvidedWidget") {}
const ProvidedWidgetLive = ProvidedWidget.make(
  { name: "provided" },
  Effect.succeed({}),
);

const ProvidedStack = Alchemy.Stack(
  "PlatformProvidedStack",
  { providers, state },
  Effect.gen(function* () {
    const widget = yield* yieldWidget(ProvidedWidget);
    return { name: widget.name };
  }).pipe(Effect.provide([ProvidedWidgetLive as Layer.Layer<never>])),
);

/** Tag WITH props and no impl — the "external" (non-Effect-native) form. */
class ExternalWidget extends Widget()("ExternalWidget", {
  name: "external",
}) {}

const ExternalStack = Alchemy.Stack(
  "PlatformExternalStack",
  { providers, state },
  Effect.gen(function* () {
    const widget = yield* yieldWidget(ExternalWidget);
    return { name: widget.name };
  }),
);

const PlainStack = Alchemy.Stack(
  "PlatformPlainStack",
  { providers, state },
  Effect.gen(function* () {
    const widget = yield* yieldWidget(Widget("PlainWidget", { name: "plain" }));
    return { name: widget.name };
  }),
);

/**
 * Forward reference: the tag is yielded OUTSIDE the Layer's region — before
 * the Layer has built — and again inside it. This is the #874 shape (a
 * worker tag in another worker's `env` resolves during that worker's
 * async-binding pass) reduced to the minimal harness: the first yield
 * registers with `undefined` props, the Layer's build repairs them, and the
 * plan must see the repaired registration.
 */
class FwdWidget extends Widget()("FwdWidget") {}
const FwdWidgetLive = FwdWidget.make({ name: "forward" }, Effect.succeed({}));

const ForwardRefStack = Alchemy.Stack(
  "PlatformForwardRefStack",
  { providers, state },
  Effect.gen(function* () {
    yield* yieldWidget(FwdWidget);
    const real = yield* yieldWidget(FwdWidget).pipe(
      Effect.provide([FwdWidgetLive as Layer.Layer<never>]),
    );
    return { name: real.name };
  }),
);

/** The bare tag yielded twice — registration must stay idempotent. */
class DoubleBareWidget extends Widget()("DoubleBareWidget") {}

const DoubleBareStack = Alchemy.Stack(
  "PlatformDoubleBareStack",
  { providers, state },
  Effect.gen(function* () {
    yield* yieldWidget(DoubleBareWidget);
    yield* yieldWidget(DoubleBareWidget);
    return {};
  }),
);

describe("tagged platform resource yielded without its impl layer", () => {
  test(
    "fails fast, naming the class and its layer",
    Effect.gen(function* () {
      const exit = yield* runDeploy(MissingImplStack);

      expect(Exit.isFailure(exit)).toBe(true);
      const message = String(Exit.isFailure(exit) ? exit.cause : "");
      expect(message).toContain("Test.PlatformWidget<BareWidget>");
      expect(message).toContain("BareWidget.make(");
      expect(message).toContain("Provide it to the Stack's program");
      expect(message).toContain("Effect.provide([BareWidgetLive])");
      // The provider must never be reached with undefined props.
      expect(observed.ran).toBe(false);
    }),
    { timeout: 60_000 },
  );

  test(
    "still deploys when the .make(...) layer IS provided",
    Effect.gen(function* () {
      const exit = yield* runDeploy(ProvidedStack);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect((observed.news as any)?.name).toBe("provided");
    }),
    { timeout: 60_000 },
  );

  test(
    "still deploys a tag declared WITH props and no impl",
    Effect.gen(function* () {
      const exit = yield* runDeploy(ExternalStack);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect((observed.news as any)?.name).toBe("external");
      expect((observed.news as any)?.isExternal).toBe(true);
    }),
    { timeout: 60_000 },
  );

  test(
    "still deploys a plain (non-tagged) instance",
    Effect.gen(function* () {
      const exit = yield* runDeploy(PlainStack);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect((observed.news as any)?.name).toBe("plain");
    }),
    { timeout: 60_000 },
  );

  test(
    "a forward reference yielded before the layer builds still deploys",
    Effect.gen(function* () {
      const exit = yield* runDeploy(ForwardRefStack);
      expect(Exit.isSuccess(exit)).toBe(true);
      // The provider must see the Layer's props, not the forward
      // reference's `undefined`.
      expect((observed.news as any)?.name).toBe("forward");
    }),
    { timeout: 60_000 },
  );

  test(
    "yielding the bare tag twice registers once and still fails fast",
    Effect.gen(function* () {
      const exit = yield* runDeploy(DoubleBareStack);
      expect(Exit.isFailure(exit)).toBe(true);
      const message = String(Exit.isFailure(exit) ? exit.cause : "");
      expect(message).toContain("Test.PlatformWidget<DoubleBareWidget>");
      expect(observed.ran).toBe(false);
    }),
    { timeout: 60_000 },
  );
});
