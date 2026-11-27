import * as Cloudflare from "@alchemy.run/cloudflare";
import type { Rpc } from "alchemy/Rpc";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

type Assert<T extends true> = T;
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

class Greeter extends Cloudflare.Worker<
  Greeter,
  { greet: (name: string) => Effect.Effect<string> }
>()("Greeter") {}

const inlineGreeter = Cloudflare.Worker(
  "InlineGreeter",
  { main: import.meta.url },
  Effect.succeed({ greet: (name: string) => Effect.succeed(`Hello ${name}`) }),
);

// A ref taken from a declaration keeps the declaration's type.
const classRef = Cloudflare.Worker.ref(Greeter, { stack: "GreeterStack" });
type _ClassRef = Assert<Equals<Effect.Success<typeof classRef>, Effect.Success<typeof Greeter>>>;
type _ClassRefHasRpc = Assert<Effect.Success<typeof classRef> extends Rpc<Greeter> ? true : false>;
// It never resolves the declaration, so it requires nothing.
type _ClassRefRequiresNothing = Assert<Equals<Effect.Services<typeof classRef>, never>>;

const inlineRef = Cloudflare.Worker.ref(inlineGreeter, { stack: "GreeterStack" });
type _InlineRef = Assert<
  Equals<Effect.Success<typeof inlineRef>, Effect.Success<typeof inlineGreeter>>
>;

// A ref by logical id is an untyped Worker.
const idRef = Cloudflare.Worker.ref("Greeter", { stack: "GreeterStack" });
type _IdRef = Assert<Equals<Effect.Success<typeof idRef>, Cloudflare.Worker>>;

// A typed ref binds as a typed service binding.
export const Api = Cloudflare.Worker(
  "Api",
  { main: import.meta.url },
  Effect.gen(function* () {
    const greeter = yield* Cloudflare.Workers.bindWorker(classRef);
    const inline = yield* Cloudflare.Workers.bindWorker(inlineRef);
    return {
      fetch: Effect.gen(function* () {
        const a: string = yield* greeter.greet("world");
        const b: string = yield* inline.greet("world");
        return HttpServerResponse.text(a + b);
      }),
    };
  }),
);

// @ts-expect-error a ref needs a Worker declaration or a logical id.
Cloudflare.Worker.ref(Effect.succeed(1));
