/**
 * Minimal Railway stack: a Project and an image Service.
 * The full graph (Postgres, Redis, Bucket, Volume, Variable,
 * Environment, TcpProxy, Effect Service + bindings) is
 * `examples/railway-service`.
 */
import * as Alchemy from "alchemy";
import * as Railway from "alchemy/Railway";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "RailwayProjectExample",
  {
    providers: Railway.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const site = yield* Railway.Project("Site");
    const web = yield* Railway.Service("Web", {
      project: site,
      image: "hashicorp/http-echo",
      port: 5678,
    });

    return {
      url: web.url,
      projectId: site.projectId,
      projectName: site.name,
      serviceId: web.serviceId,
    };
  }),
);
