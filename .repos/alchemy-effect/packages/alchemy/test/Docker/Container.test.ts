import * as Docker from "@/Docker";
import * as Provider from "@/Provider";
import {
  inMemoryState,
  isResourceState,
  State,
  type ResourceState,
} from "@/State";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { findAvailablePort } from "./Runtime.ts";

const { test } = Test.make({
  providers: Docker.providers(),
  state: inMemoryState(),
  adopt: true,
});

test.provider("diff replaces a container when its image changes", () =>
  Effect.gen(function* () {
    const containerProvider = yield* Provider.findProvider(Docker.Container);
    const containerDiff = yield* containerProvider.diff!({
      id: "web",
      fqn: "web",
      instanceId: "instance",
      olds: { name: "web", image: "nginx:alpine" },
      news: { name: "web", image: "nginx:1.27-alpine" },
      oldBindings: [],
      newBindings: [],
      output: {
        id: "web",
        name: "web",
        status: "created",
        createdAt: 0,
        imageRef: "nginx:alpine",
        ports: {},
      },
    });
    expect(containerDiff).toEqual({ action: "replace", deleteFirst: true });
  }),
);

test.provider("diff replaces a container when its Docker context changes", () =>
  Effect.gen(function* () {
    const containerProvider = yield* Provider.findProvider(Docker.Container);
    const containerDiff = yield* containerProvider.diff!({
      id: "web",
      fqn: "web",
      instanceId: "instance",
      olds: {
        name: "web",
        image: "nginx:alpine",
        context: "default",
      },
      news: {
        name: "web",
        image: "nginx:alpine",
        context: "remote-build",
      },
      oldBindings: [],
      newBindings: [],
      output: {
        id: "web",
        name: "web",
        status: "created",
        createdAt: 0,
        imageRef: "nginx:alpine",
        ports: {},
      },
    });
    expect(containerDiff).toEqual({ action: "replace", deleteFirst: true });
  }),
);

test.provider(
  "diff replaces a container when its labels or stop timeout change",
  () =>
    Effect.gen(function* () {
      const containerProvider = yield* Provider.findProvider(Docker.Container);
      const containerDiff = yield* containerProvider.diff!({
        id: "web",
        fqn: "web",
        instanceId: "instance",
        olds: {
          name: "web",
          image: "nginx:alpine",
          labels: { "traefik.enable": "true" },
          stopTimeout: "10 seconds",
        },
        news: {
          name: "web",
          image: "nginx:alpine",
          labels: { "traefik.enable": "false" },
          stopTimeout: "30 seconds",
        },
        oldBindings: [],
        newBindings: [],
        output: {
          id: "web",
          name: "web",
          status: "created",
          createdAt: 0,
          imageRef: "nginx:alpine",
          ports: {},
        },
      });
      expect(containerDiff).toEqual({ action: "replace", deleteFirst: true });
    }),
);

describe("Docker.Container", { concurrent: false }, () => {
  test.provider("publishes and inspects bound host ports", (stack) =>
    Effect.gen(function* () {
      const docker = yield* Docker.Docker;
      const hostPort = yield* findAvailablePort();
      // No explicit name: rely on the engine-generated physical name.
      const container = yield* stack.deploy(
        Docker.Container("nginx-container", {
          image: "nginx:alpine",
          ports: [{ external: hostPort, internal: 80 }],
          start: true,
        }),
      );
      expect(container.name.length).toBeGreaterThan(0);
      expect(container.status).toBe("running");

      const runtime = yield* docker.container.inspect(container.name);
      // Docker always publishes the IPv4 (`0.0.0.0`) binding; whether it also
      // adds an IPv6 (`::`) binding depends on the daemon's IPv6 config, so
      // assert the guaranteed IPv4 mapping is present rather than requiring
      // both.
      expect(runtime?.NetworkSettings.Ports?.["80/tcp"]).toEqual(
        expect.arrayContaining([
          { HostIp: "0.0.0.0", HostPort: `${hostPort}` },
        ]),
      );
    }),
  );

  test.provider("creates a stopped container when start is false", (stack) =>
    Effect.gen(function* () {
      const container = yield* stack.deploy(
        Docker.Container("stopped-container", {
          image: "nginx:alpine",
          start: false,
        }),
      );
      expect(container.status).toBe("created");
      expect(container.imageRef).toBe("nginx:alpine");
    }),
  );

  test.provider("applies container labels and a stop timeout", (stack) =>
    Effect.gen(function* () {
      const docker = yield* Docker.Docker;
      const container = yield* stack.deploy(
        Docker.Container("traefik-container", {
          image: "nginx:alpine",
          labels: {
            "traefik.enable": "true",
            "traefik.http.services.web.loadbalancer.server.port": "80",
          },
          stopTimeout: "10 minutes",
          start: true,
        }),
      );

      const info = yield* docker.container.inspect(container.name);
      expect(info.Config.Labels).toEqual(
        expect.objectContaining({
          "traefik.enable": "true",
          "traefik.http.services.web.loadbalancer.server.port": "80",
        }),
      );
      expect(info.Config.StopTimeout).toBe(600);
    }),
  );

  test.provider(
    "updates network aliases without replacing the container",
    (stack) =>
      Effect.gen(function* () {
        const docker = yield* Docker.Docker;
        // No explicit names: the engine generates stable physical names that
        // stay constant across the two deploys (same instance id).
        const deployWithAlias = (alias: string) =>
          stack.deploy(
            Effect.gen(function* () {
              const network = yield* Docker.Network("alias-network");
              const container = yield* Docker.Container("alias-container", {
                image: "nginx:alpine",
                networks: [{ name: network.name, aliases: [alias] }],
              });
              return { container, network };
            }),
          );

        const first = yield* deployWithAlias("old-alias");
        const second = yield* deployWithAlias("new-alias");
        expect(second.container.id).toBe(first.container.id);

        const info = yield* docker.container.inspect(second.container.name);
        const aliases =
          info?.NetworkSettings.Networks?.[second.network.name]?.Aliases ?? [];
        expect(aliases).toContain("new-alias");
        expect(aliases).not.toContain("old-alias");
      }),
  );

  test.provider("replaces the container when published ports change", (stack) =>
    Effect.gen(function* () {
      const firstPort = yield* findAvailablePort();
      const secondPort = yield* findAvailablePort();
      const first = yield* stack.deploy(
        Docker.Container("ported-container", {
          image: "nginx:alpine",
          ports: [{ external: firstPort, internal: 80 }],
        }),
      );
      const second = yield* stack.deploy(
        Docker.Container("ported-container", {
          image: "nginx:alpine",
          ports: [{ external: secondPort, internal: 80 }],
        }),
      );
      expect(second.id).not.toBe(first.id);
      expect(second.ports["80/tcp"]).toBe(secondPort);
    }),
  );

  // Rewrite the container's persisted row into the wedged shape an
  // interrupted deploy leaves behind: `creating`, no attributes, and the
  // Output-valued `image` prop lost in the round-trip (#736).
  const wedgeContainerRow = (stack: { readonly name: string }) =>
    Effect.gen(function* () {
      const state = yield* yield* State;
      const stage = "test"; // scratch stacks default to the "test" stage
      const fqns = yield* state.list({ stack: stack.name, stage });
      const rows = yield* Effect.forEach(fqns, (fqn) =>
        state
          .get({ stack: stack.name, stage, fqn })
          .pipe(Effect.map((row) => ({ fqn, row }))),
      );
      const wedged = rows.find(
        (r): r is { fqn: string; row: ResourceState } =>
          isResourceState(r.row) && r.row.resourceType === "Docker.Container",
      );
      if (!wedged) {
        return yield* Effect.die(
          new Error("no Docker.Container state row found after deploy"),
        );
      }
      yield* state.set({
        stack: stack.name,
        stage,
        fqn: wedged.fqn,
        value: {
          ...wedged.row,
          status: "creating",
          attr: undefined,
          props: { ...wedged.row.props, image: undefined },
        },
      });
    });

  test.provider(
    "read recovers a creating-state container whose image prop was lost (#736)",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const docker = yield* Docker.Docker;

        const deployContainer = () =>
          stack.deploy(
            // No explicit name: the engine-generated physical name is stable
            // across both deploys, so `read` can find the live container.
            Docker.Container("read-recovery-container", {
              image: "nginx:alpine",
              start: false,
            }),
          );

        const created = yield* deployContainer();
        // Safety net: remove the container if the test dies mid-way.
        yield* Effect.addFinalizer(() =>
          docker.container.remove(created.name, true).pipe(Effect.ignore),
        );

        yield* wedgeContainerRow(stack);

        // Before the fix this crashed in `read` with
        // `TypeError: undefined is not an object (evaluating 'image.imageRef')`.
        const recovered = yield* deployContainer();
        // Same container id — read/reconcile converged on the existing
        // container instead of creating a duplicate.
        expect(recovered.id).toBe(created.id);
        expect(recovered.imageRef).toBe("nginx:alpine");

        yield* stack.destroy();
      }),
    { timeout: 240_000 },
  );

  test.provider(
    "diff recreates a creating-state container that vanished after its image prop was lost (#736)",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const docker = yield* Docker.Docker;

        const deployContainer = () =>
          stack.deploy(
            Docker.Container("diff-recovery-container", {
              image: "nginx:alpine",
              start: false,
            }),
          );

        const created = yield* deployContainer();
        // Safety net: remove the container if the test dies mid-way.
        yield* Effect.addFinalizer(() =>
          docker.container.remove(created.name, true).pipe(Effect.ignore),
        );

        yield* wedgeContainerRow(stack);
        // Remove the container out-of-band so recovery `read` misses and the
        // engine falls through to `diff` with the junk creating-row props.
        yield* docker.container.remove(created.name, true);

        // Before the fix this crashed in `diff` with
        // `TypeError: undefined is not an object (evaluating 'image.imageRef')`.
        const recovered = yield* deployContainer();
        expect(recovered.id).not.toBe(created.id);
        expect(recovered.imageRef).toBe("nginx:alpine");
        expect(recovered.status).toBe("created");

        yield* stack.destroy();
      }),
    { timeout: 240_000 },
  );

  test.provider(
    "passes environment values into the container (#1117)",
    (stack) =>
      Effect.gen(function* () {
        const docker = yield* Docker.Docker;
        // Environment values ride the Docker CLI's process environment (the
        // create args carry name-only `--env KEY` flags to keep secrets off
        // the command line) — before the fix every entry resolved empty.
        const container = yield* stack.deploy(
          Docker.Container("env-container", {
            image: "nginx:alpine",
            environment: {
              PLAIN_VALUE: "plain-value",
              SECRET_VALUE: Redacted.make("secret-value"),
            },
            start: false,
          }),
        );

        const info = yield* docker.container.inspect(container.name);
        expect(info.Config.Env).toEqual(
          expect.arrayContaining([
            "PLAIN_VALUE=plain-value",
            "SECRET_VALUE=secret-value",
          ]),
        );
      }),
  );

  test.provider("applies a healthcheck with unit-suffixed durations", (stack) =>
    Effect.gen(function* () {
      const docker = yield* Docker.Docker;
      // `normalizeDuration` used to emit a bare nanosecond count (e.g.
      // `1000000000`), which `docker container create` rejects with "missing
      // unit in duration" — so this deploy would fail outright before the fix.
      const container = yield* stack.deploy(
        Docker.Container("healthcheck-container", {
          image: "nginx:alpine",
          healthcheck: {
            cmd: "true",
            interval: "1 second",
            timeout: "2 seconds",
            retries: 3,
            startPeriod: "1 second",
          },
          start: true,
        }),
      );
      expect(container.status).toBe("running");

      // Docker reports the configured durations back in nanoseconds — assert
      // they round-tripped rather than being dropped or truncated.
      const info = yield* docker.container.inspect(container.name);
      const health = info?.Config.Healthcheck;
      expect(health?.Interval).toBe(1_000_000_000);
      expect(health?.Timeout).toBe(2_000_000_000);
      expect(health?.Retries).toBe(3);
      expect(health?.StartPeriod).toBe(1_000_000_000);
    }),
  );
  test.provider(
    "reports the host port Docker assigned to a random publish (#1388)",
    (stack) =>
      Effect.gen(function* () {
        const docker = yield* Docker.Docker;
        const container = yield* stack.deploy(
          Docker.Container("random-port-container", {
            image: "nginx:alpine",
            // `external: 0` = "any free host port".
            ports: [{ external: 0, internal: 80 }],
            start: true,
          }),
        );

        // Before the fix this was 0: the create arg asked for host port 0
        // literally, and the requested binding was then reported over the
        // assigned one.
        const assigned = container.ports["80/tcp"];
        expect(assigned).toBeGreaterThan(0);

        // …and it is the port the container is actually published on.
        const runtime = yield* docker.container.inspect(container.name);
        expect(runtime?.NetworkSettings.Ports?.["80/tcp"]).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ HostPort: `${assigned}` }),
          ]),
        );
      }),
  );

  test.provider("forwards extra hosts to the container (#1387)", (stack) =>
    Effect.gen(function* () {
      const docker = yield* Docker.Docker;
      const container = yield* stack.deploy(
        Docker.Container("extra-hosts-container", {
          image: "nginx:alpine",
          extraHosts: [
            "host.docker.internal:host-gateway",
            "db.internal:10.1.2.3",
          ],
          start: true,
        }),
      );

      const runtime = yield* docker.container.inspect(container.name);
      expect(runtime?.HostConfig.ExtraHosts).toEqual(
        expect.arrayContaining([
          "host.docker.internal:host-gateway",
          "db.internal:10.1.2.3",
        ]),
      );
    }),
  );

  test.provider(
    "disconnects only the networks alchemy connected (#1386)",
    (stack) =>
      Effect.gen(function* () {
        const docker = yield* Docker.Docker;
        const foreign = "alchemy-test-foreign-network";

        const deploy = (attach: boolean) =>
          stack.deploy(
            Effect.gen(function* () {
              const network = yield* Docker.Network("managed-network");
              const container = yield* Docker.Container("managed-container", {
                image: "nginx:alpine",
                networks: attach ? [{ name: network.name }] : [],
              });
              return { container, network };
            }),
          );

        const first = yield* deploy(true);

        // A network alchemy never connected the container to — the case a
        // user, compose file, or another tool creates.
        yield* docker.network
          .create({ name: foreign, driver: "bridge" })
          .pipe(Effect.ignore);
        yield* Effect.addFinalizer(() =>
          docker.network.remove(foreign).pipe(Effect.ignore),
        );
        yield* docker.network.connect({
          network: foreign,
          container: first.container.name,
        });

        // Drop the managed network from the desired state.
        const second = yield* deploy(false);
        expect(second.container.id).toBe(first.container.id);

        const info = yield* docker.container.inspect(second.container.name);
        const attached = Object.keys(info?.NetworkSettings.Networks ?? {});
        // Ours goes…
        expect(attached).not.toContain(first.network.name);
        // …the foreign one and Docker's own default stay. Before the fix the
        // reconciler swept every live network and tore off both.
        expect(attached).toContain(foreign);
        expect(attached).toContain("bridge");
      }),
    { timeout: 240_000 },
  );
});
