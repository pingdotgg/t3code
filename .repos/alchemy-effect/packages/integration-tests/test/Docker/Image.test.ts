import * as Docker from "@alchemy.run/docker";
import { DockerEnvironment } from "@alchemy.run/docker/Docker";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { inMemoryState, State } from "alchemy/State";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import { authenticatedRegistry, scopedBuildx } from "./Runtime.ts";

const { test } = Test.make({ providers: Docker.providers(), state: inMemoryState() });

describe(
  "Docker.Image",
  { tags: ["provider:docker", "provider:docker:image", "local"], concurrent: false },
  () => {
    test.provider("plans an update when the Docker context changes", (stack) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-docker-context-plan-" });
        yield* fs.writeFileString(path.join(root, "Dockerfile"), "FROM scratch\n");

        const base = Docker.Image("context-image", {
          tag: "latest",
          context: "default",
          build: { context: root },
        });
        const changed = Docker.Image("context-image", {
          tag: "latest",
          context: "remote-build",
          build: { context: root },
        });

        yield* stack.deploy(base);
        const plan = yield* stack.plan(changed);
        expect(plan.resources["context-image"]).toMatchObject({ action: "update" });
      }),
    );

    test.provider("plans an image whose context is missing from the local docker", (stack) =>
      Effect.gen(function* () {
        const docker = yield* Docker.Docker;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "alchemy-docker-missing-context-",
        });
        yield* fs.writeFileString(
          path.join(root, "Dockerfile"),
          "FROM scratch\nLABEL alchemy.test=missing-context\n",
        );

        const endpoint = (yield* docker.run([
          "context",
          "inspect",
          "--format",
          "{{.Endpoints.docker.Host}}",
        ])).stdout.trim();

        const program = Effect.gen(function* () {
          const context = yield* Docker.Context("machine-local-context", {
            docker: `host=${endpoint}`,
          });
          const image = yield* Docker.Image("machine-local-image", {
            tag: "latest",
            context,
            build: { context: root },
          });
          return { context, image };
        });

        yield* stack.destroy();
        const first = yield* stack.deploy(program);
        yield* docker.context.remove(first.context.name, true);

        const plan = yield* stack.plan(program);
        expect(plan.resources["machine-local-context"]).toMatchObject({ action: "update" });
        expect(plan.resources["machine-local-image"]).toMatchObject({ action: "update" });

        const second = yield* stack.deploy(program);
        expect(second.image.imageRef).toBe(first.image.imageRef);
        const live = yield* docker.context.inspect(first.context.name);
        expect(live.Name).toBe(first.context.name);

        yield* stack.destroy();
      }),
    );

    test.provider("builds a tiny Dockerfile with an auto-generated name", (stack) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-docker-image-" });
        yield* fs.writeFileString(
          path.join(root, "Dockerfile"),
          "FROM scratch\nLABEL alchemy.test=true\n",
        );
        // No explicit name: the engine auto-generates the physical name.
        const image = yield* stack.deploy(
          Docker.Image("tiny-image", { tag: "latest", build: { context: root } }),
        );
        expect(image.imageRef.endsWith(":latest")).toBe(true);
        expect(image.imageId.length).toBeGreaterThan(0);
      }),
    );

    test.provider("updates when the build context changes", (stack) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-docker-canary-" });
        yield* fs.writeFileString(path.join(root, "Dockerfile"), "FROM scratch\n");
        yield* fs.writeFileString(
          path.join(root, "Dockerfile"),
          "FROM scratch\nLABEL alchemy.test=1\n",
        );

        const makeStack = Docker.Image("tiny-image", { tag: "latest", build: { context: root } });

        yield* stack.deploy(makeStack);
        const plan1 = yield* stack.plan(makeStack);
        expect(plan1.resources["tiny-image"]).toMatchObject({ action: "noop" });
        yield* fs.writeFileString(
          path.join(root, "Dockerfile"),
          "FROM scratch\nLABEL alchemy.test=2\n",
        );
        const plan2 = yield* stack.plan(makeStack);
        expect(plan2.resources["tiny-image"]).toMatchObject({ action: "update" });
      }),
    );

    test.provider("builds with an explicit repository name and tag", (stack) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-docker-image-named-" });
        yield* fs.writeFileString(
          path.join(root, "Dockerfile"),
          "FROM scratch\nLABEL alchemy.test=named\n",
        );
        const image = yield* stack.deploy(
          Docker.Image("named-image", {
            name: "alchemy-test-named",
            tag: "v1",
            build: { context: root },
          }),
        );
        expect(image.name).toBe("alchemy-test-named");
        expect(image.imageRef).toBe("alchemy-test-named:v1");
        expect(image.tag).toBe("v1");
      }),
    );

    test.provider("rebuilds when the build context changes", (stack) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-docker-image-rebuild-" });
        const dockerfile = path.join(root, "Dockerfile");

        yield* fs.writeFileString(dockerfile, "FROM scratch\nLABEL gen=1\n");
        const first = yield* stack.deploy(
          Docker.Image("rebuilt-image", { tag: "latest", build: { context: root } }),
        );

        yield* fs.writeFileString(dockerfile, "FROM scratch\nLABEL gen=2\n");
        const second = yield* stack.deploy(
          Docker.Image("rebuilt-image", { tag: "latest", build: { context: root } }),
        );

        expect(second.imageRef).toBe(first.imageRef);
      }),
    );

    // A build failing inside a `RUN` step must say why, not just its exit
    // code: the step's own output has to reach the deploy error. BuildKit
    // logs steps to stderr; the legacy builder (no Buildx plugin, or
    // `DOCKER_BUILDKIT=0`) logs them to stdout and only the exit reason to
    // stderr.
    for (const [builder, buildkit] of [
      ["BuildKit", undefined],
      ["the legacy builder", "0"],
    ] as const) {
      test.provider(
        `reports the failing RUN step's output when a build fails with ${builder}`,
        (stack) =>
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const root = yield* fs.makeTempDirectoryScoped({
              prefix: "alchemy-docker-image-fail-",
            });
            yield* fs.writeFileString(
              path.join(root, "Dockerfile"),
              // Computed in the step so only the step's output, never the echoed
              // command, contains the expected text.
              'FROM alpine:3.19\nRUN echo "npm ERR! missing script: build-$((40 + 2))" && exit 3\n',
            );
            yield* Effect.acquireRelease(
              Effect.sync(() => {
                const previous = process.env.DOCKER_BUILDKIT;
                if (buildkit === undefined) delete process.env.DOCKER_BUILDKIT;
                else process.env.DOCKER_BUILDKIT = buildkit;
                return previous;
              }),
              (previous) =>
                Effect.sync(() => {
                  if (previous === undefined) delete process.env.DOCKER_BUILDKIT;
                  else process.env.DOCKER_BUILDKIT = previous;
                }),
            );

            const error = yield* stack
              .deploy(Docker.Image("failing-image", { tag: "latest", build: { context: root } }))
              .pipe(Effect.flip);

            const report = yield* Effect.sync(() => String(error) + JSON.stringify(error));
            expect(report).toContain("npm ERR! missing script: build-42");
          }),
        // Mutates `process.env.DOCKER_BUILDKIT`.
        { exclusive: true },
      );
    }

    test.provider("builds FROM a private base image with the registry credentials", (stack) =>
      Effect.gen(function* () {
        const docker = yield* Docker.Docker;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        // Anonymous pulls get 401, and nothing on the host holds a
        // `docker login` for this ephemeral port.
        const { host, credentials: registry } = yield* authenticatedRegistry();
        const baseRef = `${host}/alchemy-base:v1`;
        yield* Effect.addFinalizer(() =>
          docker.image.remove([baseRef, `${host}/alchemy-app:v1`], true).pipe(Effect.ignore),
        );

        // Publish the private base image, then drop the local copy so the
        // build below has to pull it from the authenticated registry.
        yield* stack.deploy(
          Docker.RemoteImage("private-base", {
            name: "busybox",
            tag: "latest",
            targetName: `${host}/alchemy-base`,
            targetTag: "v1",
            registry,
          }),
        );
        yield* docker.image.remove(baseRef, true);

        const root = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-docker-private-base-" });
        yield* fs.writeFileString(
          path.join(root, "Dockerfile"),
          `FROM ${baseRef}\nLABEL alchemy.test=private-base\n`,
        );

        const image = yield* stack.deploy(
          Docker.Image("private-base-app", {
            name: `${host}/alchemy-app`,
            tag: "v1",
            registry,
            build: { context: root },
          }),
        );
        expect(image.imageRef).toBe(`${host}/alchemy-app:v1`);
        expect(image.repoDigest).toContain(`${host}/alchemy-app@sha256:`);
      }),
    );

    // Publish `busybox` as a private base image, then drop the local copy so
    // a build has to pull it back through the registry's auth.
    const publishPrivateBase = (
      host: string,
      credentials: Docker.RegistryCredentials,
      repository: string,
    ) =>
      Effect.gen(function* () {
        const docker = yield* Docker.Docker;
        const ref = `${host}/${repository}:v1`;
        yield* docker.image.pull("busybox:latest");
        yield* docker.image.tag("busybox:latest", ref);
        yield* docker.image.push(ref, credentials);
        yield* docker.image.remove(ref, true);
        yield* Effect.addFinalizer(() => docker.image.remove(ref, true).pipe(Effect.ignore));
        return ref;
      });

    const dockerfileContext = (dockerfile: string) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-docker-build-auth-" });
        yield* fs.writeFileString(path.join(root, "Dockerfile"), dockerfile);
        return root;
      });

    test.provider("authenticates the build but does not push when skipPush is set", (stack) =>
      Effect.gen(function* () {
        const registry = yield* authenticatedRegistry();
        const baseRef = yield* publishPrivateBase(registry.host, registry.credentials, "skip-base");
        const root = yield* dockerfileContext(`FROM ${baseRef}\nLABEL alchemy.test=skip-push\n`);

        yield* stack.deploy(
          Docker.Image("skip-push-app", {
            name: `${registry.host}/skip-push-app`,
            tag: "v1",
            registry: registry.credentials,
            skipPush: true,
            build: { context: root },
          }),
        );
        expect(yield* registry.hasManifest("skip-push-app", "v1")).toBe(false);
      }),
    );

    test.provider("fails the build with 401 when the registry credentials are wrong", (stack) =>
      Effect.gen(function* () {
        const registry = yield* authenticatedRegistry();
        const baseRef = yield* publishPrivateBase(
          registry.host,
          registry.credentials,
          "wrong-base",
        );
        const root = yield* dockerfileContext(`FROM ${baseRef}\n`);

        const error = yield* stack
          .deploy(
            Docker.Image("wrong-credentials-app", {
              name: `${registry.host}/wrong-credentials-app`,
              tag: "v1",
              registry: { ...registry.credentials, password: Redacted.make("not-the-password") },
              build: { context: root },
            }),
          )
          .pipe(Effect.flip);
        const report = yield* Effect.sync(() => String(error) + JSON.stringify(error));
        expect(report).toMatch(/401|unauthorized/i);
        expect(report).not.toContain("not-the-password");
        expect(yield* registry.hasManifest("wrong-credentials-app", "v1")).toBe(false);
      }),
    );

    test.provider("keeps existing DOCKER_AUTH_CONFIG credentials for other registries", (stack) =>
      Effect.gen(function* () {
        // Base A lives behind credentials the user already has in
        // DOCKER_AUTH_CONFIG; base B behind the Image's own `registry`.
        const a = yield* authenticatedRegistry();
        const b = yield* authenticatedRegistry();
        const baseA = yield* publishPrivateBase(a.host, a.credentials, "base-a");
        const baseB = yield* publishPrivateBase(b.host, b.credentials, "base-b");
        const auth = yield* Effect.sync(() =>
          Buffer.from("alchemy:alchemy-test-password").toString("base64"),
        );
        const root = yield* dockerfileContext(
          `FROM ${baseA} AS a\nFROM ${baseB}\nCOPY --from=a /bin/busybox /from-a\n`,
        );

        // As if exported before starting Alchemy.
        const image = yield* stack
          .deploy(
            Docker.Image("two-registries-app", {
              name: `${b.host}/two-registries-app`,
              tag: "v1",
              registry: b.credentials,
              build: { context: root },
            }),
          )
          .pipe(
            Effect.provide(
              ConfigProvider.layer(
                ConfigProvider.fromUnknown({
                  DOCKER_AUTH_CONFIG: JSON.stringify({ auths: { [a.host]: { auth } } }),
                }),
              ),
            ),
          );
        expect(image.repoDigest).toContain(`${b.host}/two-registries-app@sha256:`);
      }),
    );

    test.provider("merges a DockerEnvironment auth config with the process one", (stack) =>
      Effect.gen(function* () {
        // Base A behind the user's own DOCKER_AUTH_CONFIG, base C behind one a
        // provider passes through DockerEnvironment, push to B's `registry`.
        const a = yield* authenticatedRegistry();
        const b = yield* authenticatedRegistry();
        const c = yield* authenticatedRegistry();
        const baseA = yield* publishPrivateBase(a.host, a.credentials, "base-a");
        const baseC = yield* publishPrivateBase(c.host, c.credentials, "base-c");
        const auth = yield* Effect.sync(() =>
          Buffer.from("alchemy:alchemy-test-password").toString("base64"),
        );
        const root = yield* dockerfileContext(
          `FROM ${baseA} AS a\nFROM ${baseC}\nCOPY --from=a /bin/busybox /from-a\n`,
        );

        const image = yield* stack
          .deploy(
            Docker.Image("merged-auth-app", {
              name: `${b.host}/merged-auth-app`,
              tag: "v1",
              registry: b.credentials,
              build: { context: root },
            }),
          )
          .pipe(
            Effect.provideService(DockerEnvironment, {
              DOCKER_AUTH_CONFIG: JSON.stringify({ auths: { [c.host]: { auth } } }),
            }),
            Effect.provide(
              ConfigProvider.layer(
                ConfigProvider.fromUnknown({
                  DOCKER_AUTH_CONFIG: JSON.stringify({ auths: { [a.host]: { auth } } }),
                }),
              ),
            ),
          );
        expect(image.repoDigest).toContain(`${b.host}/merged-auth-app@sha256:`);
      }),
    );

    test.provider("never writes the registry password to state", (stack) =>
      Effect.gen(function* () {
        const registry = yield* authenticatedRegistry();
        const baseRef = yield* publishPrivateBase(
          registry.host,
          registry.credentials,
          "state-base",
        );
        const root = yield* dockerfileContext(`FROM ${baseRef}\n`);
        yield* stack.deploy(
          Docker.Image("state-app", {
            name: `${registry.host}/state-app`,
            tag: "v1",
            registry: registry.credentials,
            build: { context: root },
          }),
        );
        const state = yield* yield* State;
        const fqns = yield* state.list({ stack: stack.name, stage: stack.stage });
        const rows = yield* Effect.forEach(fqns, (fqn) =>
          state.get({ stack: stack.name, stage: stack.stage, fqn }),
        );
        const persisted = yield* Effect.sync(() => JSON.stringify(rows));
        expect(persisted).not.toContain("alchemy-test-password");
      }),
    );

    // The legacy builder (no Buildx plugin) also honors DOCKER_AUTH_CONFIG.
    // Buildx < 0.26 does not; that limit is documented on `registry`.
    for (const [builder, version] of [["without a Buildx plugin", undefined]] as const) {
      test.provider(
        `builds FROM a private base image ${builder}`,
        (stack) =>
          Effect.gen(function* () {
            const registry = yield* authenticatedRegistry();
            const baseRef = yield* publishPrivateBase(
              registry.host,
              registry.credentials,
              `builder-base-${version ?? "legacy"}`,
            );
            yield* scopedBuildx(version);
            const root = yield* dockerfileContext(`FROM ${baseRef}\n`);
            const image = yield* stack.deploy(
              Docker.Image(`builder-app-${version ?? "legacy"}`, {
                name: `${registry.host}/builder-app`,
                tag: version ?? "legacy",
                registry: registry.credentials,
                build: { context: root },
              }),
            );
            expect(image.repoDigest).toContain(`${registry.host}/builder-app@sha256:`);
          }),
        // Mutates `process.env.DOCKER_CONFIG` / `DOCKER_HOST`.
        { exclusive: true, timeout: 180_000 },
      );
    }
  },
);
