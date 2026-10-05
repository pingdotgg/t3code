import { Stack, type StackServices, type StackProps } from "@/Stack.ts";
import type { State } from "@/State/State.ts";
import * as Test from "@/Test/Alchemy.ts";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";

// Pins https://github.com/alchemy-run/alchemy/issues/1384: the Stack factory
// attaches runtime metadata that the overloads previously omitted.

type Expect<T extends true> = T;
type HasStackName<T> = T extends { readonly stackName: string } ? true : false;
type HasKey<T, K extends string> = K extends keyof T ? true : false;

declare const providers: Layer.Layer<never, never, StackServices>;
declare const state: Layer.Layer<State, never, StackServices>;
declare const options: StackProps<never>;

const configured = Stack(
  "Configured",
  { providers, state },
  Effect.succeed({ value: "ok" as const }),
);

type _ConfiguredHasName = Expect<HasStackName<typeof configured>>;
type _ConfiguredHasProviders = Expect<HasKey<typeof configured, "providers">>;
type _ConfiguredHasState = Expect<HasKey<typeof configured, "state">>;

configured satisfies Test.MakeOptions<never>;
Test.make(configured);

const classRef = Stack<{ value: string }, { value: string }>()("NamedStack");

type _ClassRefHasName = Expect<HasStackName<typeof classRef>>;
const _asNamed: { readonly stackName: string } = classRef;

const fromMake = classRef.make(options, Effect.succeed({ value: "ok" }));

type _MakeHasName = Expect<HasStackName<typeof fromMake>>;
type _MakeHasProviders = Expect<HasKey<typeof fromMake, "providers">>;
type _MakeHasState = Expect<HasKey<typeof fromMake, "state">>;

fromMake satisfies Test.MakeOptions<never>;
Test.make(fromMake);

class NamedStack extends Stack<
  NamedStack,
  {
    value: string;
  }
>()("NamedStack") {}

type _SubclassHasName = Expect<HasStackName<typeof NamedStack>>;
const _subclassAsNamed: { readonly stackName: string } = NamedStack;

class InlineStack extends Stack<InlineStack>()(
  "InlineStack",
  { providers, state },
  Effect.succeed({ value: 1 }),
) {}

type _InlineHasName = Expect<HasStackName<typeof InlineStack>>;
// @ts-expect-error Inline class references do not retain providers.
InlineStack.providers;
// @ts-expect-error Inline class references do not retain state.
InlineStack.state;
// @ts-expect-error Inline class references are not test harness configuration.
InlineStack satisfies Test.MakeOptions<never>;
// @ts-expect-error Configure a class reference with .make before reusing it.
Test.make(InlineStack);
