import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import Agent from "./Agent.ts";

// A second Worker that binds the same `Agent` Durable Object as `Api`. Each
// `yield* Agent` runs the DO's outer init, which calls
// `Cloudflare.Container.bind(Sandbox)` and pushes a binding onto the Sandbox
// ContainerApplication carrying the Agent namespace. With two Workers binding
// the same DO, the Sandbox ends up with two bindings that share a single
// `namespaceId` — the regression case for the dedupe fix in this PR.
export class SecondaryApi extends Cloudflare.Worker<SecondaryApi>()(
  "SecondaryApi",
  {
    main: import.meta.filename,
    observability: { enabled: true },
  },
) {}

export default SecondaryApi.make(
  Effect.gen(function* () {
    const agents = yield* Agent;

    return {
      fetch: Effect.gen(function* () {
        const body = yield* agents
          .getByName("sandbox-test")
          .hello()
          .pipe(Effect.orDie);
        return HttpServerResponse.text(body);
      }),
    };
  }),
);
