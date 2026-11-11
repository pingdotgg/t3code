import * as Docker from "@alchemy.run/docker";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { inMemoryState } from "alchemy/State";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Path from "effect/Path";
import { authenticatedRegistry } from "./Runtime.ts";

/**
 * The Docker resources against a real Podman, declared in code with
 * `Docker.providers({ bin })`. Set `ALCHEMY_TEST_PODMAN_BIN` to a `podman`
 * executable to run them; Podman must treat `localhost` registries as
 * insecure (plain HTTP).
 */
const podman = process.env.ALCHEMY_TEST_PODMAN_BIN;

const { test } = Test.make({
  providers: Docker.providers({ bin: podman ?? "podman" }),
  state: inMemoryState(),
});

// The registry runs on the host's Docker: its published port is reachable
// from the test and from Podman alike.
const hostRegistry = () => authenticatedRegistry().pipe(Effect.provide(Docker.DockerLive));

/** The digest the registry serves for `repository:tag`. */
const registryDigest = (host: string, repository: string, tag: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const basic = Buffer.from("alchemy:alchemy-test-password").toString("base64");
    const response = yield* client.execute(
      HttpClientRequest.head(`http://${host}/v2/${repository}/manifests/${tag}`).pipe(
        HttpClientRequest.setHeaders({
          authorization: `Basic ${basic}`,
          accept: [
            "application/vnd.oci.image.index.v1+json",
            "application/vnd.oci.image.manifest.v1+json",
            "application/vnd.docker.distribution.manifest.list.v2+json",
            "application/vnd.docker.distribution.manifest.v2+json",
          ].join(", "),
        }),
      ),
    );
    return response.headers["docker-content-digest"];
  });

describe.skipIf(!podman)(
  "Docker resources on Podman",
  { tags: ["provider:docker", "local"], concurrent: false },
  () => {
    // Podman reports a missing image as "image not known"; the first plan
    // reads the image before it exists.
    test.provider("builds an image whose first read finds nothing", (stack) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-podman-build-" });
        yield* fs.writeFileString(path.join(root, "Dockerfile"), "FROM scratch\nLABEL podman=1\n");

        const image = yield* stack.deploy(
          Docker.Image("podman-local-image", { tag: "v1", build: { context: root } }),
        );
        expect(image.imageId.length).toBeGreaterThan(0);
        yield* stack.destroy();
      }),
    );

    // `podman push` prints no `digest:` line, so the digest comes from the
    // image's RepoDigests after the push.
    test.provider("reports the pushed digest of a built image", (stack) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const registry = yield* hostRegistry();
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-podman-push-" });
        yield* fs.writeFileString(path.join(root, "Dockerfile"), "FROM scratch\nLABEL podman=2\n");

        const image = yield* stack.deploy(
          Docker.Image("podman-pushed-image", {
            name: `${registry.host}/podman-app`,
            tag: "v1",
            registry: registry.credentials,
            build: { context: root },
          }),
        );
        const digest = yield* registryDigest(registry.host, "podman-app", "v1");
        expect(digest).toMatch(/^sha256:/);
        expect(image.repoDigest).toBe(`${registry.host}/podman-app@${digest}`);
        yield* stack.destroy();
      }),
    );

    test.provider("reports the pushed digest of a re-tagged remote image", (stack) =>
      Effect.gen(function* () {
        const registry = yield* hostRegistry();
        const image = yield* stack.deploy(
          Docker.RemoteImage("podman-remote-image", {
            name: "docker.io/library/busybox",
            tag: "1.36",
            targetName: `${registry.host}/podman-busybox`,
            targetTag: "v1",
            registry: registry.credentials,
          }),
        );
        const digest = yield* registryDigest(registry.host, "podman-busybox", "v1");
        expect(digest).toMatch(/^sha256:/);
        expect(image.repoDigest).toBe(`${registry.host}/podman-busybox@${digest}`);
        yield* stack.destroy();
      }),
    );
  },
);
