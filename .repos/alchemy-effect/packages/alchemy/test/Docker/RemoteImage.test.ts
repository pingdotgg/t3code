import * as Docker from "@/Docker";
import * as Provider from "@/Provider";
import { inMemoryState } from "@/State";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { findAvailablePort, isDockerReady } from "./Runtime.ts";

const { test } = Test.make({
  providers: Docker.providers(),
  state: inMemoryState(),
});

test.provider("diff pulls again unless alwaysPull is disabled", () =>
  Effect.gen(function* () {
    const provider = yield* Provider.findProvider(Docker.RemoteImage);
    const output = {
      imageRef: "nginx:alpine",
      imageId: "sha256:0",
      createdAt: 0,
      name: "nginx",
      tag: "alpine",
    };

    const pinned = yield* provider.diff!({
      id: "nginx",
      fqn: "nginx",
      instanceId: "instance",
      olds: { name: "nginx", tag: "alpine", alwaysPull: false },
      news: { name: "nginx", tag: "alpine", alwaysPull: false },
      oldBindings: [],
      newBindings: [],
      output,
    });
    expect(pinned).toBeUndefined();

    const refreshed = yield* provider.diff!({
      id: "nginx",
      fqn: "nginx",
      instanceId: "instance",
      olds: { name: "nginx", tag: "alpine", alwaysPull: false },
      news: { name: "nginx", tag: "alpine" },
      oldBindings: [],
      newBindings: [],
      output,
    });
    expect(refreshed).toEqual({ action: "update" });
  }),
);

describe("Docker.RemoteImage", { concurrent: false }, () => {
  test.provider.skipIf(!isDockerReady)(
    "pulls a Docker image reference",
    (stack) =>
      Effect.gen(function* () {
        const image = yield* stack.deploy(
          Docker.RemoteImage("remote-nginx", {
            name: "nginx",
            tag: "alpine",
            alwaysPull: false,
          }),
        );
        expect(image.imageRef).toBe("nginx:alpine");
        expect(image.imageId.length).toBeGreaterThan(0);
      }),
  );

  test.provider.skipIf(!isDockerReady)(
    "pulls then re-tags under a new repository",
    (stack) =>
      Effect.gen(function* () {
        const docker = yield* Docker.Docker;
        const targetName = "alchemy-test-hello";
        const targetTag = "retagged";
        const targetRef = `${targetName}:${targetTag}`;
        // RemoteImage.delete is a no-op, so reclaim the re-tagged image here.
        yield* Effect.addFinalizer(() =>
          docker.image.remove([targetRef], true).pipe(Effect.ignore),
        );

        const image = yield* stack.deploy(
          Docker.RemoteImage("retagged-hello", {
            name: "hello-world",
            tag: "latest",
            targetName,
            targetTag,
          }),
        );
        expect(image.imageRef).toBe(targetRef);
        expect(image.name).toBe(targetName);
        expect(image.tag).toBe(targetTag);
        expect(image.imageId.length).toBeGreaterThan(0);

        const inspected = yield* docker.image.inspect(targetRef);
        expect(inspected.Id.length).toBeGreaterThan(0);
      }),
  );

  test.provider.skipIf(!isDockerReady)(
    "pulls, re-tags, and pushes to a registry",
    (stack) =>
      Effect.gen(function* () {
        const docker = yield* Docker.Docker;
        const client = yield* HttpClient.HttpClient;
        const port = yield* findAvailablePort();
        const registryName = "alchemy-test-registry";
        const host = `localhost:${port}`;
        const targetName = `${host}/alchemy-hello`;
        const targetTag = "v1";
        const targetRef = `${targetName}:${targetTag}`;

        yield* Effect.addFinalizer(() =>
          Effect.all([
            docker.run(["rm", "-f", registryName]),
            docker.image.remove(targetRef, true),
          ]).pipe(Effect.ignore),
        );

        yield* docker.run([
          "run",
          "-d",
          "--name",
          registryName,
          "-p",
          `${port}:5000`,
          "registry:2",
        ]);

        // Wait for the registry HTTP API to start serving before pushing.
        yield* client.get(`http://${host}/v2/`).pipe(
          Effect.retry({
            schedule: Schedule.exponential("250 millis"),
            times: 20,
          }),
        );

        const image = yield* stack.deploy(
          Docker.RemoteImage("pushed-hello", {
            name: "hello-world",
            tag: "latest",
            targetName,
            targetTag,
            registry: {
              server: host,
              username: "alchemy",
              password: Redacted.make("ignored-by-insecure-registry"),
            },
          }),
        );

        expect(image.imageRef).toBe(targetRef);
        expect(image.repoDigest).toBeDefined();
        expect(image.repoDigest).toContain(`${targetName}@sha256:`);
      }),
  );
});
