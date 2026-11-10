import * as Container from "@alchemy.run/gcp/Container";
import * as Kubernetes from "@alchemy.run/kubernetes";
import * as Neon from "@alchemy.run/neon";
import { expect, test } from "@alchemy.run/test";
import * as Effect from "effect/Effect";

// Resource Effects declared at module scope, as in a typical stack file.
const Local = Kubernetes.LocalCluster("Local", { name: "local" });
const Gke = Container.Cluster("Gke", { location: "us-central1", autopilot: true });
const Db = Neon.Project("Db", {});
const Main = Effect.gen(function* () {
  return yield* Neon.Branch("Main", { project: yield* Db });
});

const impl = Effect.gen(function* () {
  return { fetch: Effect.die("unused") };
});

const typeCases = () =>
  Effect.gen(function* () {
    // A cluster prop accepts the cluster resource's Effect directly…
    yield* Kubernetes.Deployment(
      "Local",
      { main: import.meta.url, cluster: Local, port: 3000 },
      impl,
    );
    yield* Kubernetes.Deployment("Gke", { main: import.meta.url, cluster: Gke, port: 3000 }, impl);
    // …as well as the yielded resource.
    yield* Kubernetes.Deployment(
      "Yielded",
      { main: import.meta.url, cluster: yield* Gke, port: 3000 },
      impl,
    );

    // A Neon Function's branch or project accepts the resource's Effect directly…
    yield* Neon.Function("Branch", { main: import.meta.url, branch: Main }, impl);
    yield* Neon.Function("Project", { main: import.meta.url, project: Db }, impl);
    // …as well as the yielded resource.
    yield* Neon.Function("Yielded", { main: import.meta.url, branch: yield* Main }, impl);
    // @ts-expect-error Exactly one scope is required.
    yield* Neon.Function("Both", { main: import.meta.url, branch: Main, project: Db }, impl);
  });

test.effect(
  "Effect-valued cluster, branch and project props are compiled by the workspace check",
  () =>
    Effect.sync(() => {
      expect(typeof typeCases).toBe("function");
    }),
  { tags: ["unit", "provider:kubernetes", "provider:neon", "local"] },
);
