import * as Docker from "@alchemy.run/docker";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { adopt, OwnedBySomeoneElse } from "alchemy/AdoptPolicy";
import { inMemoryState } from "alchemy/State";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { ensureDockerSwarm } from "./Runtime.ts";

const { test } = Test.make({ providers: Docker.providers(), state: inMemoryState() });

// Every test deploys real swarm services through the engine (plan → apply →
// destroy) — no provider-method unit tests. The suite self-provisions a
// single-node swarm on the local engine (`ensureDockerSwarm`), so it runs
// anywhere Docker runs; deactivate afterwards with `docker swarm leave
// --force` if you don't want the node to stay a swarm manager.
describe(
  "Docker.Service",
  { tags: ["provider:docker", "provider:docker:service", "local"], concurrent: false },
  () => {
    test.provider(
      "creates a replicated service with labels",
      (stack) =>
        Effect.gen(function* () {
          yield* ensureDockerSwarm;
          const serviceName = "alchemy-test-service-create";
          const service = yield* stack.deploy(
            Docker.Service("created-service", {
              name: serviceName,
              image: "nginx:alpine",
              replicas: 1,
              labels: { "com.alchemy.test": "true" },
            }),
          );

          expect(service.name).toBe(serviceName);
          expect(service.id.length).toBeGreaterThan(0);
          expect(service.image).toContain("nginx:alpine");
          expect(service.replicas).toBe(1);
          expect(service.endpointMode).toBe("vip");
          expect(service.labels["com.alchemy.test"]).toBe("true");

          yield* stack.destroy();

          const docker = yield* Docker.Docker;
          const gone = yield* docker.service.inspect(service.id).pipe(
            Effect.map(() => false),
            Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(true)),
          );
          expect(gone).toBe(true);
        }),
      { timeout: 240_000 },
    );

    test.provider(
      "scales a service in place when replicas change",
      (stack) =>
        Effect.gen(function* () {
          yield* ensureDockerSwarm;
          const serviceName = "alchemy-test-service-replicas";

          const first = yield* stack.deploy(
            Docker.Service("scaled-service", {
              name: serviceName,
              image: "nginx:alpine",
              replicas: 1,
            }),
          );
          expect(first.replicas).toBe(1);

          const second = yield* stack.deploy(
            Docker.Service("scaled-service", {
              name: serviceName,
              image: "nginx:alpine",
              replicas: 2,
            }),
          );

          expect(second.id).toBe(first.id);
          expect(second.replicas).toBe(2);

          const third = yield* stack.deploy(
            Docker.Service("scaled-service", {
              name: serviceName,
              image: "nginx:alpine",
              replicas: 0,
            }),
          );
          expect(third.id).toBe(first.id);
          expect(third.replicas).toBe(0);

          yield* stack.destroy();
        }),
      { timeout: 240_000 },
    );

    test.provider(
      "rolls a new image onto the existing service",
      (stack) =>
        Effect.gen(function* () {
          yield* ensureDockerSwarm;
          const docker = yield* Docker.Docker;
          const service = (image: string) =>
            Docker.Service("rolled-service", {
              name: "alchemy-test-service-rollout",
              image,
              labels: { tier: "web" },
              environment: { MODE: "test" },
              constraints: ["node.role==manager"],
              updateConfig: { order: "start-first", failureAction: "rollback", parallelism: 0 },
            });

          const first = yield* stack.deploy(service("nginx:1.27-alpine"));
          const plan = yield* stack.plan(service("nginx:1.28-alpine"));
          expect(plan.resources["rolled-service"]).toMatchObject({ action: "update" });
          const second = yield* stack.deploy(service("nginx:1.28-alpine"));

          expect(second.id).toBe(first.id);
          expect(second.image).toContain("nginx:1.28-alpine");
          expect(second.labels.tier).toBe("web");

          // The previous spec is kept by swarm only when the service was
          // updated, not recreated.
          const previous = yield* docker
            .run([
              "service",
              "inspect",
              second.id,
              "--format",
              "{{json .PreviousSpec.TaskTemplate.ContainerSpec.Image}}",
            ])
            .pipe(Effect.map((output) => JSON.parse(output.stdout) as string));
          expect(previous).toContain("nginx:1.27-alpine");

          const order = yield* docker
            .run(["service", "inspect", second.id, "--format", "{{.Spec.UpdateConfig.Order}}"])
            .pipe(Effect.map((output) => output.stdout.trim()));
          expect(order).toBe("start-first");

          // `--constraint-add` appends, so re-adding an existing constraint
          // would duplicate it; `0` (update every task at once) must reach
          // the CLI rather than being dropped as falsy.
          const spec = yield* docker
            .run(["service", "inspect", second.id, "--format", "{{json .Spec}}"])
            .pipe(
              Effect.map(
                (output) =>
                  JSON.parse(output.stdout) as {
                    TaskTemplate: { Placement?: { Constraints?: string[] } };
                    UpdateConfig?: { Parallelism?: number };
                  },
              ),
            );
          expect(spec.TaskTemplate.Placement?.Constraints).toEqual(["node.role==manager"]);
          expect(spec.UpdateConfig?.Parallelism).toBe(0);

          yield* stack.destroy();
        }),
      { timeout: 240_000 },
    );

    test.provider(
      "rolls back and fails the deploy when updated tasks are unhealthy",
      (stack) =>
        Effect.gen(function* () {
          yield* ensureDockerSwarm;
          const docker = yield* Docker.Docker;
          const deploy = (cmd: string[], labels?: Record<string, string>) =>
            stack.deploy(
              Docker.Service("rollback-service", {
                name: "alchemy-test-service-rollback",
                image: "nginx:alpine",
                labels,
                healthcheck: { cmd, interval: "1s", timeout: "1s", retries: 1 },
                updateConfig: { failureAction: "rollback", monitor: "10s" },
              }),
            );

          const first = yield* deploy(["CMD-SHELL", "test -d /etc"]);

          const failure = yield* deploy(["CMD", "false"]).pipe(
            Effect.as(""),
            Effect.catchCause((cause) => Effect.succeed(Cause.pretty(cause))),
          );
          expect(failure).toContain("DockerServiceUpdateFailed");
          expect(failure).toContain("rollback_completed");

          const healthcheck = yield* docker
            .run([
              "service",
              "inspect",
              first.id,
              "--format",
              "{{json .Spec.TaskTemplate.ContainerSpec.Healthcheck.Test}}",
            ])
            .pipe(Effect.map((output) => JSON.parse(output.stdout)));
          expect(healthcheck).toEqual(["CMD-SHELL", "test -d /etc"]);

          // The rolled-back deploy doesn't block the next one: swarm clears
          // `rollback_completed` when it accepts this update.
          const relabeled = yield* deploy(["CMD-SHELL", "test -d /etc"], { after: "rollback" });
          expect(relabeled.id).toBe(first.id);
          expect(relabeled.labels.after).toBe("rollback");

          yield* stack.destroy();
        }),
      { timeout: 240_000 },
    );

    test.provider(
      "fails the deploy when swarm pauses an unhealthy update",
      (stack) =>
        Effect.gen(function* () {
          yield* ensureDockerSwarm;
          // No `failureAction`: swarm's default is to pause the rollout.
          const deploy = (cmd: string[]) =>
            stack.deploy(
              Docker.Service("paused-service", {
                name: "alchemy-test-service-paused",
                image: "nginx:alpine",
                healthcheck: { cmd, interval: "1s", timeout: "1s", retries: 1 },
                updateConfig: { monitor: "10s" },
              }),
            );

          yield* deploy(["CMD-SHELL", "test -d /etc"]);
          const failure = yield* deploy(["CMD", "false"]).pipe(
            Effect.as(""),
            Effect.catchCause((cause) => Effect.succeed(Cause.pretty(cause))),
          );
          expect(failure).toContain("DockerServiceUpdateFailed");
          expect(failure).toContain("paused");

          yield* stack.destroy();
        }),
      { timeout: 240_000 },
    );

    test.provider(
      "removes environment variables, ports and mounts dropped from props",
      (stack) =>
        Effect.gen(function* () {
          yield* ensureDockerSwarm;
          const docker = yield* Docker.Docker;
          const name = "alchemy-test-service-remove-entries";
          // Swarm creates the named volumes on first mount; they outlive the service.
          yield* Effect.addFinalizer(() =>
            docker
              .run(["volume", "rm", "alchemy-test-service-keep", "alchemy-test-service-drop"])
              .pipe(Effect.ignore),
          );

          const first = yield* stack.deploy(
            Docker.Service("pruned-service", {
              name,
              image: "nginx:alpine",
              environment: { KEEP: "1", DROP: "1" },
              ports: [{ internal: 80 }, { internal: 443 }],
              volumes: [
                { hostPath: "alchemy-test-service-keep", containerPath: "/keep" },
                { hostPath: "alchemy-test-service-drop", containerPath: "/drop" },
              ],
            }),
          );

          const second = yield* stack.deploy(
            Docker.Service("pruned-service", {
              name,
              image: "nginx:alpine",
              environment: { KEEP: "2" },
              ports: [{ internal: 80 }],
              volumes: [
                { hostPath: "alchemy-test-service-keep", containerPath: "/keep", readOnly: true },
              ],
            }),
          );
          expect(second.id).toBe(first.id);

          const spec = yield* docker
            .run(["service", "inspect", second.id, "--format", "{{json .Spec}}"])
            .pipe(
              Effect.map(
                (output) =>
                  JSON.parse(output.stdout) as {
                    TaskTemplate: {
                      ContainerSpec: {
                        Env?: string[];
                        Mounts?: Array<{ Target: string; ReadOnly?: boolean }>;
                      };
                    };
                    EndpointSpec?: { Ports?: Array<{ TargetPort: number }> };
                  },
              ),
            );
          expect(spec.TaskTemplate.ContainerSpec.Env).toEqual(["KEEP=2"]);
          // `--mount-add` on an existing target replaces that mount.
          expect(
            (spec.TaskTemplate.ContainerSpec.Mounts ?? []).map((m) => [m.Target, m.ReadOnly]),
          ).toEqual([["/keep", true]]);
          expect((spec.EndpointSpec?.Ports ?? []).map((port) => port.TargetPort)).toEqual([80]);

          yield* stack.destroy();
        }),
      { timeout: 240_000 },
    );

    test.provider(
      "replaces a service when one of two ports sharing a target is dropped",
      (stack) =>
        Effect.gen(function* () {
          yield* ensureDockerSwarm;
          const docker = yield* Docker.Docker;
          const service = (external: number[]) =>
            Docker.Service("shared-target-service", {
              name: "alchemy-test-service-shared-target",
              image: "nginx:alpine",
              ports: external.map((port) => ({ external: port, internal: 80 })),
            });

          yield* stack.deploy(service([43121, 43122]));
          // `--publish-rm target=80` would drop both ports and
          // `--publish-add` skips the one already in the spec.
          const plan = yield* stack.plan(service([43122]));
          expect(plan.resources["shared-target-service"]).toMatchObject({ action: "replace" });
          const second = yield* stack.deploy(service([43122]));

          const published = yield* docker
            .run(["service", "inspect", second.id, "--format", "{{json .Spec.EndpointSpec.Ports}}"])
            .pipe(
              Effect.map((output) =>
                (JSON.parse(output.stdout) as Array<{ PublishedPort: number }>).map(
                  (port) => port.PublishedPort,
                ),
              ),
            );
          expect(published).toEqual([43122]);

          yield* stack.destroy();
        }),
      { timeout: 240_000 },
    );

    test.provider(
      "updates the image of a service with secrets, configs and networks attached",
      (stack) =>
        Effect.gen(function* () {
          yield* ensureDockerSwarm;
          const docker = yield* Docker.Docker;
          const secretName = "alchemy-test-service-update-secret";
          const configName = "alchemy-test-service-update-config";

          // Alchemy has no swarm secret/config resource; services reference
          // existing ones by name.
          yield* docker
            .run(["secret", "rm", secretName])
            .pipe(Effect.catchCause(() => Effect.void));
          yield* docker
            .run(["config", "rm", configName])
            .pipe(Effect.catchCause(() => Effect.void));
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-docker-secret-" });
          const secretFile = path.join(dir, "secret");
          yield* fs.writeFileString(secretFile, "value");
          yield* docker.run(["secret", "create", secretName, secretFile]);
          yield* docker.run(["config", "create", configName, secretFile]);
          yield* Effect.addFinalizer(() =>
            Effect.all([
              docker.run(["secret", "rm", secretName]).pipe(Effect.ignore),
              docker.run(["config", "rm", configName]).pipe(Effect.ignore),
            ]),
          );

          // Re-adding an attached secret, config or network fails, so this
          // update exercises the detach-and-reattach path for all three.
          const deploy = (image: string) =>
            stack.deploy(
              Effect.gen(function* () {
                const network = yield* Docker.Network("secret-service-network", {
                  name: "alchemy-test-service-secret-update-net",
                  driver: "overlay",
                });
                const service = yield* Docker.Service("secret-service", {
                  name: "alchemy-test-service-secret-update",
                  image,
                  secrets: [{ source: secretName, target: "app_secret" }],
                  configs: [{ source: configName, target: "/etc/app.conf" }],
                  networks: [{ name: network.name, aliases: ["app"] }],
                });
                return { network, service };
              }),
            );

          const { service: first } = yield* deploy("nginx:1.27-alpine");
          const { network, service: second } = yield* deploy("nginx:1.28-alpine");
          expect(second.id).toBe(first.id);
          expect(second.image).toContain("nginx:1.28-alpine");

          const spec = yield* docker
            .run(["service", "inspect", second.id, "--format", "{{json .Spec.TaskTemplate}}"])
            .pipe(
              Effect.map(
                (output) =>
                  JSON.parse(output.stdout) as {
                    ContainerSpec: {
                      Secrets?: Array<{ File: { Name: string } }>;
                      Configs?: Array<{ File: { Name: string } }>;
                    };
                    Networks?: Array<{ Target: string; Aliases?: string[] }>;
                  },
              ),
            );
          expect((spec.ContainerSpec.Secrets ?? []).map((s) => s.File.Name)).toEqual([
            "app_secret",
          ]);
          expect((spec.ContainerSpec.Configs ?? []).map((c) => c.File.Name)).toEqual([
            "/etc/app.conf",
          ]);
          expect(spec.Networks).toEqual([{ Target: network.id, Aliases: ["app"] }]);

          yield* stack.destroy();
        }),
      { timeout: 240_000 },
    );

    test.provider(
      "keeps an auto-assigned published port across an update",
      (stack) =>
        Effect.gen(function* () {
          yield* ensureDockerSwarm;
          const docker = yield* Docker.Docker;
          const service = (image: string) =>
            Docker.Service("dynamic-port-service", {
              name: "alchemy-test-service-dynamic-port",
              image,
              ports: [{ internal: 80 }],
            });
          // Swarm records the port it picked on `Endpoint`, not in the spec.
          const publishedPorts = (id: string) =>
            docker
              .run(["service", "inspect", id, "--format", "{{json .Endpoint.Ports}}"])
              .pipe(
                Effect.map((output) =>
                  ((JSON.parse(output.stdout) ?? []) as Array<{ PublishedPort: number }>).map(
                    (port) => port.PublishedPort,
                  ),
                ),
              );

          const first = yield* stack.deploy(service("nginx:1.27-alpine"));
          const before = yield* publishedPorts(first.id);
          expect(before).toHaveLength(1);

          const second = yield* stack.deploy(service("nginx:1.28-alpine"));
          expect(second.id).toBe(first.id);
          expect(yield* publishedPorts(second.id)).toEqual(before);

          yield* stack.destroy();
        }),
      { timeout: 240_000 },
    );

    test.provider(
      "creates a service with zero replicas",
      (stack) =>
        Effect.gen(function* () {
          yield* ensureDockerSwarm;
          const service = yield* stack.deploy(
            Docker.Service("idle-service", {
              name: "alchemy-test-service-idle",
              image: "nginx:alpine",
              replicas: 0,
            }),
          );
          expect(service.replicas).toBe(0);

          yield* stack.destroy();
        }),
      { timeout: 240_000 },
    );

    test.provider(
      "replaces a service when its Docker context changes",
      (stack) =>
        Effect.gen(function* () {
          yield* ensureDockerSwarm;
          const serviceName = "alchemy-test-service-context";

          const first = yield* stack.deploy(
            Docker.Service("context-service", { name: serviceName, image: "nginx:alpine" }),
          );
          expect(first.context).toBeUndefined();

          // `default` is the engine's built-in context — same daemon, but a
          // different context ref, so the replace path (delete-first, recreate
          // under `--context`) runs against a real named context.
          const second = yield* stack.deploy(
            Docker.Service("context-service", {
              name: serviceName,
              image: "nginx:alpine",
              context: "default",
            }),
          );

          expect(second.id).not.toBe(first.id);
          expect(second.context).toBe("default");

          yield* stack.destroy();
        }),
      { timeout: 240_000 },
    );

    test.provider(
      "refuses a pre-existing service unless explicitly adopted",
      (stack) =>
        Effect.gen(function* () {
          yield* ensureDockerSwarm;
          const docker = yield* Docker.Docker;
          const serviceName = "alchemy-test-service-adopt-existing";

          yield* Effect.addFinalizer(() => docker.service.remove(serviceName).pipe(Effect.ignore));

          yield* docker.service
            .remove(serviceName)
            .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.void));

          yield* docker.service.create({ name: serviceName, image: "nginx:alpine", replicas: 1 });

          const error = yield* stack
            .deploy(
              Docker.Service("existing-service", {
                name: serviceName,
                image: "nginx:alpine",
                replicas: 1,
              }),
            )
            .pipe(
              Effect.as(undefined),
              Effect.catchCause((cause) => Effect.succeed(findOwnedError(cause))),
            );

          expect(error).toBeInstanceOf(OwnedBySomeoneElse);

          const adopted = yield* stack.deploy(
            Docker.Service("existing-service", {
              name: serviceName,
              image: "nginx:alpine",
              replicas: 1,
            }).pipe(adopt(true)),
          );

          expect(adopted.name).toBe(serviceName);
          expect(adopted.id.length).toBeGreaterThan(0);

          yield* stack.destroy();
        }),
      { timeout: 240_000 },
    );

    test.provider(
      "updates labels in place",
      (stack) =>
        Effect.gen(function* () {
          yield* ensureDockerSwarm;
          const serviceName = "alchemy-test-service-labels";

          const first = yield* stack.deploy(
            Docker.Service("labeled-service", {
              name: serviceName,
              image: "nginx:alpine",
              labels: { generation: "1", stale: "true" },
            }),
          );

          const second = yield* stack.deploy(
            Docker.Service("labeled-service", {
              name: serviceName,
              image: "nginx:alpine",
              labels: { generation: "2" },
            }),
          );

          expect(second.id).toBe(first.id);
          expect(second.labels.generation).toBe("2");
          expect(second.labels.stale).toBeUndefined();

          yield* stack.destroy();
        }),
      { timeout: 240_000 },
    );

    test.provider(
      "attaches a network created in the same deploy in place",
      (stack) =>
        Effect.gen(function* () {
          yield* ensureDockerSwarm;
          const serviceName = "alchemy-test-service-replace";

          const first = yield* stack.deploy(
            Docker.Service("replaceable-service", {
              name: serviceName,
              image: "nginx:alpine",
            }),
          );

          const { network, service: second } = yield* stack.deploy(
            Effect.gen(function* () {
              const network = yield* Docker.Network("replaceable-service-network", {
                name: "alchemy-test-service-replace-net",
                driver: "overlay",
              });
              const service = yield* Docker.Service("replaceable-service", {
                name: serviceName,
                image: "nginx:alpine",
                networks: [network.name],
              });
              return { network, service };
            }),
          );

          expect(second.id).toBe(first.id);
          expect(second.networks).toContain(network.id);

          yield* stack.destroy();
        }),
      { timeout: 240_000 },
    );

    test.provider(
      "applies array healthchecks and re-enables one after NONE",
      (stack) =>
        Effect.gen(function* () {
          yield* ensureDockerSwarm;
          const docker = yield* Docker.Docker;
          const deploy = (cmd: string[]) =>
            stack.deploy(
              Docker.Service("healthcheck-array-service", {
                name: "alchemy-test-service-healthcheck-array",
                image: "nginx:alpine",
                healthcheck: { cmd },
              }),
            );
          const healthcheck = (id: string) =>
            docker
              .run([
                "service",
                "inspect",
                id,
                "--format",
                "{{json .Spec.TaskTemplate.ContainerSpec.Healthcheck}}",
              ])
              .pipe(Effect.map((output) => JSON.parse(output.stdout).Test));

          const shell = yield* deploy(["CMD-SHELL", "test -d /etc"]);
          expect(yield* healthcheck(shell.id)).toEqual(["CMD-SHELL", "test -d /etc"]);

          // Disable, then turn it back on through `docker service update`.
          const disabled = yield* deploy(["NONE"]);
          expect(yield* healthcheck(disabled.id)).toEqual(["NONE"]);
          const restored = yield* deploy(["CMD", "test", "-d", "/etc"]);
          expect(yield* healthcheck(restored.id)).toEqual(["CMD-SHELL", "test -d /etc"]);

          yield* stack.destroy();
        }),
      { timeout: 240_000 },
    );

    test.provider(
      "disables the image healthcheck with NONE",
      (stack) =>
        Effect.gen(function* () {
          yield* ensureDockerSwarm;
          const docker = yield* Docker.Docker;
          const service = yield* stack.deploy(
            Docker.Service("healthcheck-none-service", {
              name: "alchemy-test-service-healthcheck-none",
              image: "nginx:alpine",
              healthcheck: { cmd: ["NONE"] },
            }),
          );

          const output = yield* docker.run([
            "service",
            "inspect",
            service.id,
            "--format",
            "{{json .Spec.TaskTemplate.ContainerSpec.Healthcheck}}",
          ]);
          expect(JSON.parse(output.stdout)).toEqual({ Test: ["NONE"] });

          yield* stack.destroy();
        }),
      { timeout: 240_000 },
    );
  },
);

const findOwnedError = (cause: Cause.Cause<unknown>): OwnedBySomeoneElse | undefined =>
  cause.reasons
    .map((reason) =>
      Cause.isFailReason(reason)
        ? reason.error
        : Cause.isDieReason(reason)
          ? reason.defect
          : undefined,
    )
    .find((value): value is OwnedBySomeoneElse => value instanceof OwnedBySomeoneElse);
