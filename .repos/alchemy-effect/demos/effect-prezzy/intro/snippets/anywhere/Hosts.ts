import * as AWS from "@alchemy.run/aws";
import * as Hetzner from "@alchemy.run/hetzner";
import * as Neon from "@alchemy.run/neon";
import * as Railway from "@alchemy.run/railway";
import * as Effect from "effect/Effect";

/** What each host needs to run on, shared by the host roll's snippets. */
export const Cluster = AWS.ECS.Cluster("Cluster", {});
export const Box = Hetzner.Server("Box", {
  serverType: "cpx12",
  image: "ubuntu-24.04",
  location: "nbg1",
});
export const Chat = Railway.Project("Chat", {});
export const Main = Effect.gen(function* () {
  return yield* Neon.Branch("Main", { project: yield* Neon.Project("Db") });
});
