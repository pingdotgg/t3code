import * as Alchemy from "alchemy";
import * as Prisma from "alchemy/Prisma";
import * as Effect from "effect/Effect";
import Api from "./src/Api.ts";
import { Project } from "./src/Database.ts";

export default Alchemy.Stack(
  "PrismaTutorial",
  { providers: Prisma.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const project = yield* Project.pipe(Alchemy.remote());
    const api = yield* Api.pipe(Alchemy.remote());
    const site = yield* Prisma.Website.Vite("Website", {
      project,
      regionId: "eu-west-3",
      env: { VITE_API_URL: api.url },
    });
    return { url: site.url, apiUrl: api.url };
  }),
);
