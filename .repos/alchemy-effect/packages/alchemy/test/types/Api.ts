import * as Cloudflare from "@/Cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import Agent from "./Agent.ts";

export const Api2 = Cloudflare.Worker(
  "Api",
  {
    main: import.meta.filename,
    observability: {
      enabled: true,
    },
    compatibility: {
      flags: ["nodejs_compat"],
    },
  },
  Effect.gen(function* () {
    const _agents = yield* Agent;

    return {
      getUser: () => Effect.succeed({ id: "123", name: "John Doe" } as const),
      fetch: Effect.gen(function* () {
        return HttpServerResponse.text("Hello World", { status: 200 });
      }),
    };
  }),
);

const _____ = Effect.gen(function* () {
  const worker = yield* Api2;
  const _url = worker.url;
  const _eff = Effect.gen(function* () {
    const rpc = yield* Cloudflare.bindWorker(worker);
    rpc.getUser();
  });

  const worker2 = yield* Api;
  const _eff2 = Effect.gen(function* () {
    const rpc2 = yield* Cloudflare.bindWorker(worker2);
    rpc2.getUser();
  });

  const worker3 = yield* Api3;
  const _eff3 = Effect.gen(function* () {
    const rpc3 = yield* Cloudflare.bindWorker(worker3);
    rpc3.getUser();
  });
});

// declare the Api service with a tag + props
export default class Api extends Cloudflare.Worker<Api>()(
  "Api",
  {
    main: import.meta.filename,
    observability: {
      enabled: true,
    },
    compatibility: {
      flags: ["nodejs_compat"],
    },
  },
  Effect.gen(function* () {
    // (Infrastructure dependencies are bound here)

    // bind the Agent DO to the Worker
    const agents = yield* Agent;

    return {
      getUser: () => Effect.succeed({ id: "123", name: "John Doe" } as const),
      fetch: Effect.gen(function* () {
        // (Business logic is implemented here and can reference bound infrastructure above)
        const request = yield* HttpServerRequest;
        if (request.url.startsWith("/connect/")) {
          // connect to a Durable Object web socket
          const agentId = request.url.split("/").pop()!;
          const agent = agents.getByName(agentId);
          const response = yield* agent.fetch(request);
          return response;
        } // else if (request.url.startsWith("/profile/")) {
        //   // call RPC methods on a Durable Object
        //   const key = request.url.split("/").pop()!;
        //   const agent = yield* agents.getByName(key);
        //   if (request.method == "GET") {
        //     const item = yield* agent.getProfile();
        //     if (item) {
        //       return HttpServerResponse.text(item);
        //     }
        //   } else if (request.method == "PUT") {
        //     yield* agent.putProfile(yield* request.text);
        //     return HttpServerResponse.text("OK", { status: 200 });
        //   } else {
        //     return HttpServerResponse.text("Method not allowed", {
        //       status: 405,
        //     });
        //   }
        // }
        return HttpServerResponse.text("Hello World", { status: 200 });
      }),
    };
  }).pipe(
    // Effect.provide(
    //   Layer.mergeAll(
    //     //
    //     // AgentLive,
    //   ),
    // ),
  ),
) {}

export class Api3 extends Cloudflare.Worker<
  Api3,
  {
    getUser: () => Effect.Effect<{ id: string; name: string }>;
  }
>()("Api3", {
  main: import.meta.filename,
  observability: {
    enabled: true,
  },
}) {}

export const Api3Live = Api3.make(
  Effect.gen(function* () {
    const agent = yield* Agent;
    return {
      getUser: Effect.fnUntraced(function* () {
        const user = agent.getByName("");

        return {
          id: "123",
          name: (yield* user.getProfile())!,
        };
      }),
    };
  }),
);
