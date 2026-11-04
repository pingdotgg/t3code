import * as Prisma from "@alchemy.run/prisma";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "PrismaWebsiteReactRouterExample",
  { providers: Prisma.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const site = yield* Prisma.Website.ReactRouter("ReactRouter", {
      env: { GREETING: "Hello from React Router on Prisma!" },
    });

    return { url: site.url };
  }),
);
