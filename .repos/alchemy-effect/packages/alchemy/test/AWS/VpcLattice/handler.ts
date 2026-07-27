import * as Lambda from "@/AWS/Lambda";
import * as VpcLattice from "@/AWS/VpcLattice";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

export class LatticeTestFunction extends Lambda.Function<Lambda.Function>()(
  "LatticeTestFunction",
) {}

export default LatticeTestFunction.make(
  {
    main,
    url: true,
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    // A LAMBDA-type target group the function manages its own registration
    // in at runtime — the self-registration data plane.
    const targetGroup = yield* VpcLattice.TargetGroup("BindingTargetGroup", {
      type: "LAMBDA",
    });

    const listTargets = yield* VpcLattice.ListTargets(targetGroup);
    const registerTargets = yield* VpcLattice.RegisterTargets(targetGroup);
    const deregisterTargets = yield* VpcLattice.DeregisterTargets(targetGroup);

    const bound = { deregisterTargets, listTargets, registerTargets };

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;

        if (request.method === "GET" && pathname === "/bindings") {
          return yield* HttpServerResponse.json({
            bound: Object.keys(bound).sort(),
          });
        }

        // List the target group's registered targets (the target group id
        // is injected from the binding).
        if (request.method === "GET" && pathname === "/targets") {
          const { items } = yield* listTargets({});
          return yield* HttpServerResponse.json({
            targets: items.map((t) => ({ id: t.id, status: t.status })),
          });
        }

        // Register a target (for a LAMBDA group: a function ARN).
        if (request.method === "POST" && pathname === "/register") {
          const body = (yield* request.json) as unknown as { id: string };
          const { successful = [], unsuccessful = [] } = yield* registerTargets(
            { targets: [{ id: body.id }] },
          );
          return yield* HttpServerResponse.json({
            successful: successful.map((t) => t.id),
            unsuccessful: unsuccessful.map((t) => ({
              failureCode: t.failureCode,
              id: t.id,
            })),
          });
        }

        // Deregister a target.
        if (request.method === "POST" && pathname === "/deregister") {
          const body = (yield* request.json) as unknown as { id: string };
          const { successful = [], unsuccessful = [] } =
            yield* deregisterTargets({ targets: [{ id: body.id }] });
          return yield* HttpServerResponse.json({
            successful: successful.map((t) => t.id),
            unsuccessful: unsuccessful.map((t) => ({
              failureCode: t.failureCode,
              id: t.id,
            })),
          });
        }

        return yield* HttpServerResponse.json(
          { error: "Not found", method: request.method, pathname },
          { status: 404 },
        );
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        VpcLattice.ListTargetsHttp,
        VpcLattice.RegisterTargetsHttp,
        VpcLattice.DeregisterTargetsHttp,
      ),
    ),
  ),
);
