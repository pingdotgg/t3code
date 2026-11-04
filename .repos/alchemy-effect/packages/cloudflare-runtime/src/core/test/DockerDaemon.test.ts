import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Docker, DockerLive } from "../Docker.ts";
import { docker } from "./helpers/docker.ts";

it.live(
  "pulls an unprepared image again after a failed container create",
  () => {
    // Unresolvable registry: the first on-demand pull must fail.
    const image = "alchemy-test.invalid/missing:retry";
    const name = `alchemy-pull-retry-${crypto.randomUUID()}`;
    return Effect.gen(function* () {
      const config = yield* (yield* Docker).getWorkerdDockerConfiguration;
      const create = Effect.promise(() =>
        fetch(`http://${config.localDocker!.socketPath}/containers/create?name=${name}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ Image: image, Env: [] }),
        }).then(async (response) => ({ status: response.status, body: await response.text() })),
      );

      const failed = yield* create;
      expect(failed.status).toBe(500);

      // Once the image exists, the same create must succeed: the failed pull
      // was not cached.
      yield* docker("pull", "alpine:3.21");
      yield* docker("tag", "alpine:3.21", image);
      const created = yield* create;
      expect(created.status).toBe(201);
    }).pipe(
      Effect.ensuring(
        Effect.ignore(docker("rm", "--force", name)).pipe(
          Effect.andThen(Effect.ignore(docker("rmi", image))),
        ),
      ),
      Effect.provide(Layer.provide(DockerLive, NodeServices.layer)),
    );
  },
  60_000,
);

it.live(
  "uses a user image that exists only in the local Docker without pulling it",
  () => {
    // A tag no registry holds, as with an image built or `docker load`ed locally.
    const image = "alchemy-test.invalid/local-only:dev";
    const tag = `alchemy-local-only-${crypto.randomUUID()}:latest`;
    return Effect.gen(function* () {
      yield* docker("pull", "--platform", "linux/amd64", "alpine:3.21");
      yield* docker("tag", "alpine:3.21", image);
      yield* (yield* Docker).pull(tag, { imageUri: image });
      const id = yield* docker("image", "inspect", tag, "--format", "{{.Id}}");
      expect(id.trim()).not.toBe("");
    }).pipe(
      Effect.ensuring(
        Effect.ignore(docker("rmi", tag)).pipe(Effect.andThen(Effect.ignore(docker("rmi", image)))),
      ),
      Effect.provide(Layer.provide(DockerLive, NodeServices.layer)),
    );
  },
  60_000,
);
