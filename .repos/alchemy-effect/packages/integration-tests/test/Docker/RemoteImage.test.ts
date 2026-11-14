import * as Docker from "@alchemy.run/docker";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { inMemoryState } from "alchemy/State";
import * as Effect from "effect/Effect";
import { localRegistry } from "./Runtime.ts";

const { test } = Test.make({ providers: Docker.providers(), state: inMemoryState() });

describe(
  "Docker.RemoteImage",
  { tags: ["provider:docker", "provider:docker:remoteimage", "local"], concurrent: false },
  () => {
    test.provider("pulls a Docker image reference", (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const image = yield* stack.deploy(
          Docker.RemoteImage("remote-nginx", { name: "nginx", tag: "alpine", alwaysPull: false }),
        );
        expect(image.imageRef).toBe("nginx:alpine");
        expect(image.imageId.length).toBeGreaterThan(0);
        yield* stack.destroy();
      }),
    );

    test.provider("pulls then re-tags under a new repository", (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const docker = yield* Docker.Docker;
        const targetName = "alchemy-test-hello";
        const targetTag = "retagged";
        const targetRef = `${targetName}:${targetTag}`;
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
        expect(inspected.Id).toBe(image.imageId);
        yield* stack.destroy();
      }),
    );

    test.provider("publishes a local source through the selected named context", (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const docker = yield* Docker.Docker;
        const registry = yield* localRegistry();
        const contextName = `alchemy-test-remote-image-${registry.host.replace(":", "-")}`;
        const currentContext = (yield* docker.run(["context", "show"])).stdout;
        yield* Effect.addFinalizer(() =>
          docker.context.remove(contextName, true).pipe(Effect.ignore),
        );
        yield* docker.context.create({ name: contextName, docker: `from=${currentContext}` });
        const sourceTag = `alchemy-local-only-${registry.host.replace(":", "-")}`;
        const sourceRef = `${sourceTag}:smoke`;
        const targetName = `${registry.host}/alchemy-local-reuse`;
        const targetTag = "smoke";
        const targetRef = `${targetName}:${targetTag}`;

        yield* Effect.addFinalizer(() =>
          docker.image.remove([sourceRef, targetRef], true).pipe(Effect.ignore),
        );

        yield* docker.image.pull("hello-world:latest");
        yield* docker.image.tag("hello-world:latest", sourceRef);
        const source = yield* docker.image.inspect(sourceRef);
        const image = yield* stack.deploy(
          Docker.RemoteImage("local-reuse", {
            name: sourceTag,
            tag: "smoke",
            alwaysPull: false,
            targetName,
            targetTag,
            registry: registry.credentials,
            context: contextName,
          }),
        );
        const target = yield* docker.image.inspect(targetRef);
        const digest = yield* registry.manifestDigest("alchemy-local-reuse", targetTag);

        expect(image.imageRef).toBe(targetRef);
        expect(image.imageId).toBe(source.Id);
        expect(target.Id).toBe(source.Id);
        expect(image.repoDigest).toBe(`${targetName}@${digest}`);
        yield* stack.destroy();
      }),
    );

    test.provider("pulls a missing local source tag", (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const docker = yield* Docker.Docker;
        const registry = yield* localRegistry();
        const sourceName = `${registry.host}/alchemy-pull-fallback`;
        const sourceRef = `${sourceName}:source`;
        const repository = "alchemy-pull-fallback";
        yield* Effect.addFinalizer(() =>
          docker.image.remove([sourceRef], true).pipe(Effect.ignore),
        );

        yield* docker.image.pull("hello-world:latest");
        yield* docker.image.tag("hello-world:latest", sourceRef);
        yield* docker.image.push(sourceRef, registry.credentials);
        const digest = yield* registry.manifestDigest(repository, "source");
        yield* docker.image.remove(sourceRef, true);
        const missing = yield* docker.image.inspect(sourceRef).pipe(Effect.flip);
        expect(missing.reason._tag).toBe("NotFound");

        const image = yield* stack.deploy(
          Docker.RemoteImage("pull-fallback", {
            name: sourceName,
            tag: "source",
            alwaysPull: false,
          }),
        );
        const pulled = yield* docker.image.inspect(sourceRef);
        expect(image.imageId).toBe(pulled.Id);
        expect(pulled.RepoDigests).toContain(`${sourceName}@${digest}`);
        yield* stack.destroy();
      }),
    );

    test.provider("pulls by default even when the source tag exists locally", (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const docker = yield* Docker.Docker;
        const registry = yield* localRegistry();
        const sourceName = `${registry.host}/alchemy-default-pull`;
        const sourceRef = `${sourceName}:source`;
        yield* Effect.addFinalizer(() =>
          docker.image.remove([sourceRef], true).pipe(Effect.ignore),
        );

        yield* docker.image.pull("hello-world:latest");
        yield* docker.image.tag("hello-world:latest", sourceRef);
        yield* docker.image.push(sourceRef, registry.credentials);
        const digest = yield* registry.manifestDigest("alchemy-default-pull", "source");
        yield* docker.image.pull("busybox:latest");
        yield* docker.image.tag("busybox:latest", sourceRef);
        const stale = yield* docker.image.inspect(sourceRef);

        const image = yield* stack.deploy(
          Docker.RemoteImage("default-pull", { name: sourceName, tag: "source" }),
        );
        const pulled = yield* docker.image.inspect(sourceRef);
        expect(image.imageId).toBe(pulled.Id);
        expect(pulled.Id).not.toBe(stale.Id);
        expect(pulled.RepoDigests).toContain(`${sourceName}@${digest}`);
        yield* stack.destroy();
      }),
    );

    test.provider("fails when the Docker context is unavailable", (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const failure = yield* stack
          .deploy(
            Docker.RemoteImage("unavailable-context", {
              name: "alchemy-test-unavailable-context",
              tag: "smoke",
              alwaysPull: false,
              context: "alchemy-test-missing-context",
            }),
          )
          .pipe(Effect.flip);
        const report = `${String(failure)} ${JSON.stringify(failure)}`;
        expect(report).toMatch(/image inspect/i);
        expect(report).not.toMatch(/image pull/i);
        yield* stack.destroy();
      }),
    );

    test.provider("updates changed source images and repairs changed target tags", (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const docker = yield* Docker.Docker;
        const registry = yield* localRegistry();
        const sourceName = `alchemy-source-${registry.host.replace(":", "-")}`;
        const sourceRef = `${sourceName}:smoke`;
        const targetName = `${registry.host}/alchemy-drift`;
        const targetTag = "published";
        const targetRef = `${targetName}:${targetTag}`;
        yield* Effect.addFinalizer(() =>
          docker.image.remove([sourceRef, targetRef], true).pipe(Effect.ignore),
        );

        yield* docker.image.pull("hello-world:latest");
        yield* docker.image.pull("busybox:latest");
        yield* docker.image.tag("hello-world:latest", sourceRef);
        const firstSource = yield* docker.image.inspect(sourceRef);
        const props = {
          name: sourceName,
          tag: "smoke",
          alwaysPull: false,
          targetName,
          targetTag,
          registry: registry.credentials,
        } as const;

        const first = yield* stack.deploy(Docker.RemoteImage("source-drift", props));
        expect(first.imageId).toBe(firstSource.Id);

        yield* docker.image.tag("busybox:latest", sourceRef);
        const changedSource = yield* docker.image.inspect(sourceRef);
        expect(changedSource.Id).not.toBe(firstSource.Id);
        const second = yield* stack.deploy(Docker.RemoteImage("source-drift", props));
        expect(second.imageId).toBe(changedSource.Id);

        yield* docker.image.tag("hello-world:latest", targetRef);
        expect((yield* docker.image.inspect(targetRef)).Id).toBe(firstSource.Id);
        const repaired = yield* stack.deploy(Docker.RemoteImage("source-drift", props));
        expect(repaired.imageId).toBe(changedSource.Id);
        expect((yield* docker.image.inspect(targetRef)).Id).toBe(changedSource.Id);
        const digest = yield* registry.manifestDigest("alchemy-drift", targetTag);
        expect(repaired.repoDigest).toBe(`${targetName}@${digest}`);
        yield* stack.destroy();
      }),
    );
  },
);
