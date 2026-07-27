import * as Lambda from "@/AWS/Lambda";
import * as OAM from "@/AWS/OAM";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

export class OamTestFunction extends Lambda.Function<Lambda.Function>()(
  "OamTestFunction",
) {}

export default OamTestFunction.make(
  {
    main,
    url: true,
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    // The monitoring-account sink the binding is bound to. Nothing ever
    // links to it (OAM rejects same-account links), so ListAttachedLinks
    // legitimately returns an empty item list — which still proves the IAM
    // grant and the SinkIdentifier injection end-to-end.
    const sink = yield* OAM.Sink("BindingSink");

    const listAttachedLinks = yield* OAM.ListAttachedLinks(sink);

    const bound = { listAttachedLinks };

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;

        if (request.method === "GET" && pathname === "/bindings") {
          return yield* HttpServerResponse.json({
            bound: Object.keys(bound),
          });
        }

        // Sink-scoped list: the SinkIdentifier is injected from the binding.
        if (request.method === "GET" && pathname === "/attached-links") {
          const { Items } = yield* listAttachedLinks();
          return yield* HttpServerResponse.json({
            count: Items.length,
            linkArns: Items.map((item) => item.LinkArn),
          });
        }

        return yield* HttpServerResponse.json(
          { error: "Not found", method: request.method, pathname },
          { status: 404 },
        );
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(OAM.ListAttachedLinksHttp)),
);
