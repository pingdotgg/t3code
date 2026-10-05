import * as machines from "@distilled.cloud/fly-io/machines";
import * as Retry from "@distilled.cloud/fly-io/Retry";
import * as Fly from "@/Fly";
import { ensureStarted } from "@/Fly/replicas";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as Result from "effect/Result";
import type { MachineContainer } from "@/Fly/Machine";

const { test } = Test.make({ providers: Fly.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const image =
  "docker-hub-mirror.fly.io/library/nginx@sha256:7396be67b6f53012a5cf955fa9040619294c25ccacf11e22af5de1b572fc756e";
const nextImage =
  "docker-hub-mirror.fly.io/library/nginx@sha256:ef8676b33d681f272ba429b27658bdd7e640963279714c96bddf1dc76307f7b6";

const workload = (
  sidecarVersion: string,
  includeObsolete = true,
): MachineContainer[] => [
  {
    name: "web",
    image,
    env: { ROLE: "web" },
    healthChecks: [
      {
        name: "web-tcp",
        kind: "readiness" as const,
        tcp: { port: 80 },
        interval: 5,
        timeout: 2,
      },
    ],
  },
  {
    name: "sidecar",
    image: sidecarVersion === "two" ? nextImage : image,
    cmd: ["sh", "-c", "sleep 300"],
    env: { ROLE: "sidecar", VERSION: sidecarVersion },
    dependsOn: [{ name: "web", condition: "healthy" as const }],
  },
  ...(includeObsolete
    ? [{ name: "obsolete", image, cmd: ["sh", "-c", "sleep 300"] }]
    : []),
];

const waitUntilGone = (appName: string, machineId: string) =>
  machines
    .getMachine({
      app_name: appName,
      machine_id: machineId,
    })
    .pipe(
      Effect.map((machine) =>
        machine.state === "destroyed" ? ("gone" as const) : ("found" as const),
      ),
      Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
      Effect.repeat({
        schedule: Schedule.spaced("2 seconds"),
        until: (status) => status === "gone",
        times: 10,
      }),
    );

test.provider(
  "create, update, and delete a machine",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const app = yield* Fly.App("Site");
          return yield* Fly.Machine("Web", {
            app,
            region: "iad",
            image: "nginx:alpine",
            guest: { cpus: 1, memoryMb: 256 },
          });
        }),
      );

      expect(created.machineId).toEqual(expect.any(String));
      expect(created.machineId.length).toBeGreaterThan(0);
      expect(created.machineIds).toEqual([created.machineId]);
      expect(created.count).toEqual(1);
      expect(created.appName).toEqual(expect.any(String));
      expect(created.name).toEqual(expect.any(String));
      expect(created.region).toEqual("iad");
      expect(created.state).toEqual("started");
      expect(created.privateIp).toEqual(expect.any(String));
      expect(created.guest?.cpus).toEqual(1);
      expect(created.guest?.memoryMb).toEqual(256);

      const fetched = yield* machines.getMachine({
        app_name: created.appName,
        machine_id: created.machineId,
      });
      expect(fetched.id).toEqual(created.machineId);
      expect(fetched.name).toEqual(created.name);
      expect(fetched.region).toEqual("iad");
      expect(fetched.state).toEqual("started");
      expect(fetched.config?.image).toEqual(expect.stringContaining("nginx"));
      expect(fetched.config?.guest?.cpus).toEqual(1);
      expect(fetched.config?.guest?.memory_mb).toEqual(256);
      expect(fetched.config?.metadata?.["alchemy.type"]).toEqual("Fly.Machine");
      expect(fetched.config?.metadata?.["alchemy.replica"]).toEqual("0");
      expect(fetched.config?.metadata?.["alchemy.stack"]).toEqual(
        expect.any(String),
      );

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const app = yield* Fly.App("Site");
          return yield* Fly.Machine("Web", {
            app,
            region: "iad",
            image: "nginx:alpine",
            guest: { cpus: 1, memoryMb: 256 },
            env: { ALCHEMY_MARK: "updated" },
            metadata: { role: "web" },
            restart: { policy: "on-failure", maxRetries: 3 },
            services: [
              {
                protocol: "tcp",
                internalPort: 80,
                ports: [{ port: 80, handlers: ["http"] }],
                checks: [
                  {
                    type: "http",
                    port: 80,
                    interval: "20s",
                    timeout: "3s",
                    gracePeriod: "6s",
                    method: "HEAD",
                    path: "/",
                    protocol: "http",
                    headers: [
                      {
                        name: "X-Alchemy-Check",
                        values: ["ready", "routing"],
                      },
                    ],
                    tlsServerName: "example.com",
                    tlsSkipVerify: true,
                  },
                ],
              },
            ],
          });
        }),
      );

      expect(updated.machineId).toEqual(created.machineId);
      expect(updated.appName).toEqual(created.appName);
      expect(updated.name).toEqual(created.name);
      expect(updated.region).toEqual("iad");
      expect(updated.state).toEqual("started");

      const refetched = yield* machines.getMachine({
        app_name: updated.appName,
        machine_id: updated.machineId,
      });
      expect(refetched.id).toEqual(created.machineId);
      expect(refetched.config?.env?.ALCHEMY_MARK).toEqual("updated");
      expect(refetched.config?.metadata?.role).toEqual("web");
      expect(refetched.config?.metadata?.["alchemy.type"]).toEqual(
        "Fly.Machine",
      );
      expect(refetched.config?.restart?.policy).toEqual("on-failure");
      expect(refetched.config?.restart?.max_retries).toEqual(3);
      expect(refetched.config?.services?.[0]?.internal_port).toEqual(80);
      expect(refetched.config?.services?.[0]?.ports?.[0]?.port).toEqual(80);
      const check = refetched.config?.services?.[0]?.checks?.[0];
      expect(check?.type).toEqual("http");
      expect(check?.port).toEqual(80);
      expect(check?.interval).toEqual("20s");
      expect(check?.timeout).toEqual("3s");
      expect(check?.grace_period).toEqual("6s");
      expect(check?.method).toEqual("HEAD");
      expect(check?.path).toEqual("/");
      expect(check?.protocol).toEqual("http");
      expect(check?.headers?.[0]?.name).toEqual("X-Alchemy-Check");
      expect(check?.headers?.[0]?.values).toEqual(["ready", "routing"]);
      expect(check?.tls_server_name).toEqual("example.com");
      expect(check?.tls_skip_verify).toEqual(true);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.appName, created.machineId);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:fly", "provider:fly:app", "provider:fly:machine", "live"],
    timeout: 180_000,
  },
);

test.provider(
  "starts an unlaunched machine and recovers from stale state",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deploy = (skipLaunch: boolean) =>
        stack.deploy(
          Effect.gen(function* () {
            const app = yield* Fly.App("LaunchSite");
            return yield* Fly.Machine("LaunchWeb", {
              app,
              region: "iad",
              image: "nginx:alpine",
              guest: { cpus: 1, memoryMb: 256 },
              skipLaunch,
              services: [
                {
                  protocol: "tcp",
                  internalPort: 80,
                  checks: [
                    {
                      type: "http",
                      port: 80,
                      path: skipLaunch ? "/missing" : "/",
                      interval: "5s",
                      timeout: "2s",
                      gracePeriod: "1s",
                    },
                  ],
                },
              ],
            });
          }),
        );
      const created = yield* deploy(true);
      const target = {
        app_name: created.appName,
        machine_id: created.machineId,
      };
      const unlaunched = yield* machines.getMachine(target);
      expect(["created", "stopped"]).toContain(unlaunched.state);
      yield* ensureStarted(created.appName, unlaunched, true);
      expect(["created", "stopped"]).toContain(
        (yield* machines.getMachine(target)).state,
      );

      const waitError = yield* machines
        .waitMachine({ ...target, state: "started", timeout: 1 })
        .pipe(Retry.none, Effect.flip);
      expect(["MachineWaitTimeout", "GatewayTimeout"]).toContain(
        waitError._tag,
      );

      const launched = yield* deploy(false);
      expect(launched.machineId).toBe(created.machineId);
      expect(launched.state).toBe("started");
      const running = yield* machines.getMachine(target);

      const alreadyStarted = yield* ensureStarted(
        created.appName,
        unlaunched,
        false,
      );
      expect(alreadyStarted.state).toBe("started");
      expect(alreadyStarted.instance_id).toBe(running.instance_id);

      yield* machines.stopMachine({ ...target, signal: "SIGTERM" });
      yield* machines
        .waitMachine({
          ...target,
          instance_id: running.instance_id,
          state: "stopped",
          timeout: 8,
        })
        .pipe(
          Effect.retry({
            while: (error) =>
              error._tag === "GatewayTimeout" ||
              error._tag === "MachineWaitTimeout",
            schedule: Schedule.spaced("1 second"),
            times: 3,
          }),
        );
      expect((yield* machines.getMachine(target)).state).toBe("stopped");

      const restarted = yield* ensureStarted(created.appName, running, false);
      expect(restarted.state).toBe("started");
      expect((yield* machines.getMachine(target)).state).toBe("started");

      yield* stack.destroy();
      expect(yield* waitUntilGone(created.appName, created.machineId)).toBe(
        "gone",
      );
    }).pipe(logLevel),
  {
    tags: ["provider:fly", "provider:fly:app", "provider:fly:machine", "live"],
    timeout: 120_000,
  },
);

test.provider(
  "replace when name changes",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const app = yield* Fly.App("ReplaceSite");
          return yield* Fly.Machine("ReplaceWeb", {
            app,
            region: "iad",
            image: "nginx:alpine",
            guest: { cpus: 1, memoryMb: 256 },
          });
        }),
      );

      expect(created.region).toEqual("iad");

      const nextName =
        created.name.slice(0, -1) + (created.name.endsWith("z") ? "y" : "z");

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          const app = yield* Fly.App("ReplaceSite");
          return yield* Fly.Machine("ReplaceWeb", {
            app,
            name: nextName,
            region: "iad",
            image: "nginx:alpine",
            guest: { cpus: 1, memoryMb: 256 },
          });
        }),
      );

      expect(replaced.machineId).not.toEqual(created.machineId);
      expect(replaced.name).toEqual(nextName);
      expect(replaced.appName).toEqual(created.appName);
      expect(replaced.region).toEqual("iad");
      expect(replaced.state).toEqual("started");

      const fetched = yield* machines.getMachine({
        app_name: replaced.appName,
        machine_id: replaced.machineId,
      });
      expect(fetched.id).toEqual(replaced.machineId);
      expect(fetched.name).toEqual(nextName);

      const oldGone = yield* waitUntilGone(created.appName, created.machineId);
      expect(oldGone).toEqual("gone");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(replaced.appName, replaced.machineId);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:fly", "provider:fly:app", "provider:fly:machine", "live"],
    timeout: 120_000,
  },
);

test.provider(
  "list enumerates the deployed machine",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const app = yield* Fly.App("ListSite");
          return yield* Fly.Machine("ListWeb", {
            app,
            region: "iad",
            image: "nginx:alpine",
            guest: { cpus: 1, memoryMb: 256 },
          });
        }),
      );

      const provider = yield* Provider.findProvider(Fly.Machine);
      const all = yield* provider.list();
      const found = all.find(
        (machine) => machine.machineId === deployed.machineId,
      );
      expect(found).toBeDefined();
      expect(found?.appName).toEqual(deployed.appName);
      expect(found?.name).toEqual(deployed.name);
      expect(found?.region).toEqual("iad");
      expect(found?.state).toEqual("started");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(deployed.appName, deployed.machineId);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:fly", "provider:fly:app", "provider:fly:machine", "live"],
    timeout: 120_000,
  },
);

test.provider(
  "destroy recovers a machine whose initial service checks failed",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const app = yield* stack.deploy(Fly.App("UnhealthySite"));
      const result = yield* stack
        .deploy(
          Effect.gen(function* () {
            const app = yield* Fly.App("UnhealthySite");
            return yield* Fly.Machine("UnhealthyWeb", {
              app,
              region: "iad",
              image: "nginx:alpine",
              guest: { cpus: 1, memoryMb: 256 },
              count: 2,
              services: [
                {
                  protocol: "tcp",
                  internalPort: 80,
                  checks: [
                    {
                      type: "http",
                      port: 80,
                      path: "/missing",
                      interval: "5s",
                      timeout: "2s",
                      gracePeriod: "1s",
                    },
                  ],
                },
              ],
            });
          }),
        )
        .pipe(Effect.result);
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure).toMatchObject({
          _tag: "Fly.ReplicaChecksNotPassing",
        });
      }
      const live = yield* machines.listMachines({ app_name: app.appName });
      expect(
        live.filter((machine) => machine.state !== "destroyed"),
      ).toHaveLength(1);
      yield* stack.destroy();
      for (const machine of live) {
        expect(yield* waitUntilGone(app.appName, machine.id!)).toBe("gone");
      }
    }).pipe(logLevel),
  {
    tags: ["provider:fly", "provider:fly:app", "provider:fly:machine", "live"],
    timeout: 120_000,
  },
);

test.provider(
  "count 2 waits for checks and leaves the next replica unchanged on failure",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deploy = (path: string) =>
        stack.deploy(
          Effect.gen(function* () {
            const app = yield* Fly.App("CheckSite");
            return yield* Fly.Machine("CheckWeb", {
              app,
              region: "iad",
              image: "nginx:alpine",
              guest: { cpus: 1, memoryMb: 256 },
              count: 2,
              services: [
                {
                  protocol: "tcp",
                  internalPort: 80,
                  ports: [{ port: 80, handlers: ["http"] }],
                  checks: [
                    {
                      type: "http",
                      port: 80,
                      method: "GET",
                      path,
                      protocol: "http",
                      interval: "5s",
                      timeout: "2s",
                      gracePeriod: "5s",
                    },
                    {
                      type: "tcp",
                      port: 80,
                      interval: "5s",
                      timeout: "2s",
                      gracePeriod: "5s",
                    },
                  ],
                },
              ],
            });
          }),
        );

      const deployed = yield* deploy("/");
      expect(deployed.count).toEqual(2);
      expect(deployed.machineIds).toHaveLength(2);
      expect(deployed.replicas).toHaveLength(2);
      expect(deployed.state).toEqual("started");
      expect(deployed.replicas[0]?.state).toEqual("started");
      expect(deployed.replicas[1]?.state).toEqual("started");

      for (const machineId of deployed.machineIds) {
        const live = yield* machines.getMachine({
          app_name: deployed.appName,
          machine_id: machineId,
        });
        expect(live.state).toEqual("started");
        const serviceChecks =
          live.checks?.filter((check) =>
            check.name?.startsWith("servicecheck-"),
          ) ?? [];
        expect(serviceChecks).toHaveLength(2);
        expect(
          serviceChecks.every((check) => check.status === "passing"),
        ).toEqual(true);
      }

      const secondBefore = yield* machines.getMachine({
        app_name: deployed.appName,
        machine_id: deployed.machineIds[1]!,
      });
      const failed = yield* deploy("/missing").pipe(Effect.result);
      expect(Result.isFailure(failed)).toBe(true);
      if (Result.isFailure(failed)) {
        expect(failed.failure).toMatchObject({
          _tag: "Fly.ReplicaChecksNotPassing",
        });
      }
      const first = yield* machines.getMachine({
        app_name: deployed.appName,
        machine_id: deployed.machineIds[0]!,
      });
      const second = yield* machines.getMachine({
        app_name: deployed.appName,
        machine_id: deployed.machineIds[1]!,
      });
      expect(first.config?.services?.[0]?.checks?.[0]?.path).toBe("/missing");
      expect(first.checks?.some((check) => check.status !== "passing")).toBe(
        true,
      );
      expect(second.config?.services?.[0]?.checks?.[0]?.path).toBe("/");
      expect(second.instance_id).toBe(secondBefore.instance_id);

      const recovered = yield* deploy("/");
      expect(recovered.machineIds).toEqual(deployed.machineIds);
      for (const machineId of recovered.machineIds) {
        const live = yield* machines.getMachine({
          app_name: recovered.appName,
          machine_id: machineId,
        });
        expect(
          live.checks?.filter((check) =>
            check.name?.startsWith("servicecheck-"),
          ),
        ).toEqual([
          expect.objectContaining({ status: "passing" }),
          expect.objectContaining({ status: "passing" }),
        ]);
      }
      yield* stack.destroy();

      for (const machineId of deployed.machineIds) {
        const gone = yield* waitUntilGone(deployed.appName, machineId);
        expect(gone).toEqual("gone");
      }
    }).pipe(logLevel),
  {
    tags: ["provider:fly", "provider:fly:app", "provider:fly:machine", "live"],
    timeout: 180_000,
  },
);

test.provider(
  "rolling named containers preserve group, digest pins, and mounted data",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const deploy = (version: string, includeObsolete = true) =>
        stack.deploy(
          Effect.gen(function* () {
            const app = yield* Fly.App("MultiContainerSite");
            return yield* Fly.Machine("Group", {
              app,
              region: "fra",
              guest: { cpus: 1, memoryMb: 256 },
              env: { COMMON: "machine", ROLE: "machine" },
              containers: workload(version, includeObsolete),
              mounts: [{ path: "/data", sizeGb: 1, encrypted: true }],
            });
          }),
        );
      const first = yield* deploy("one");
      expect(first.state).toEqual("started");
      const target = { app_name: first.appName, machine_id: first.machineId };
      const observed = yield* machines.getMachine(target);
      expect(
        observed.config?.containers?.map((container) => container.name),
      ).toEqual(["web", "sidecar", "obsolete"]);
      expect(
        observed.config?.containers?.map((container) => container.image),
      ).toEqual([image, image, image]);
      expect(observed.config?.env?.COMMON).toEqual("machine");
      expect(observed.config?.containers?.[0]?.env?.ROLE).toEqual("web");
      expect(observed.config?.containers?.[1]?.env?.ROLE).toEqual("sidecar");
      expect(observed.config?.containers?.[1]?.depends_on).toEqual([
        { name: "web", condition: "healthy" },
      ]);

      const connected = yield* machines
        .execMachine({
          ...target,
          container: "sidecar",
          command: [
            "sh",
            "-c",
            "wget -qO- http://127.0.0.1:80/ | grep -q 'Welcome to nginx' && printf connected",
          ],
          timeout: 10,
        })
        .pipe(
          Effect.repeat({
            schedule: Schedule.spaced("2 seconds"),
            times: 8,
            until: (result) => result.stdout?.includes("connected") === true,
          }),
        );
      expect(connected.stdout).toContain("connected");
      expect(connected.exit_code).toBe(0);
      const environment = yield* machines.execMachine({
        ...target,
        container: "sidecar",
        command: ["sh", "-c", 'printf "%s|%s" "$COMMON" "$ROLE"'],
        timeout: 10,
      });
      expect(environment.stdout).toContain("machine|sidecar");
      expect(environment.exit_code).toBe(0);
      const written = yield* machines.execMachine({
        ...target,
        container: "web",
        command: [
          "sh",
          "-c",
          "printf persistent > /data/ogm-1764-marker && cat /data/ogm-1764-marker",
        ],
        timeout: 10,
      });
      expect(written.stdout).toContain("persistent");

      const unchanged = yield* deploy("one");
      expect(unchanged.machineId).toEqual(first.machineId);
      const same = yield* machines.getMachine(target);
      expect(same.instance_id).toEqual(observed.instance_id);

      const updated = yield* deploy("two", false);
      expect(updated.machineId).toEqual(first.machineId);
      expect(updated.mounts[0]?.volumeId).toEqual(first.mounts[0]?.volumeId);
      const after = yield* machines.getMachine(target);
      expect(
        after.config?.containers?.map((container) => container.name),
      ).toEqual(["web", "sidecar"]);
      expect(
        after.config?.containers?.map((container) => container.image),
      ).toEqual([image, nextImage]);
      expect(after.config?.containers?.[1]?.env?.VERSION).toEqual("two");
      const persisted = yield* machines.execMachine({
        ...target,
        container: "web",
        command: ["cat", "/data/ogm-1764-marker"],
        timeout: 10,
      });
      expect(persisted.stdout).toContain("persistent");
      yield* stack.destroy();
      const gone = yield* machines.getApp({ app_name: first.appName }).pipe(
        Effect.as(false),
        Effect.catchTag("NotFound", () => Effect.succeed(true)),
      );
      expect(gone).toBe(true);
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider(
  "rerun converges on a named group already updated outside Alchemy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const deploy = (sidecarImage: string) =>
        stack.deploy(
          Effect.gen(function* () {
            const app = yield* Fly.App("InterruptedMultiContainerSite");
            return yield* Fly.Machine("Group", {
              app,
              region: "fra",
              guest: { cpus: 1, memoryMb: 256 },
              mounts: [{ path: "/data", sizeGb: 1, encrypted: true }],
              containers: [
                { name: "web", image },
                {
                  name: "sidecar",
                  image: sidecarImage,
                  cmd: ["sh", "-c", "sleep 300"],
                },
              ],
            });
          }),
        );
      const first = yield* deploy(image);
      const target = { app_name: first.appName, machine_id: first.machineId };

      // Apply the next deployment directly, as if Fly accepted Alchemy's
      // update but the response never arrived.
      const before = yield* machines.getMachine(target);
      const accepted = yield* machines.updateMachine({
        ...target,
        config: {
          ...before.config,
          containers: before.config?.containers?.map((container) =>
            container.name === "sidecar"
              ? { ...container, image: nextImage }
              : container,
          ),
        },
      });
      yield* machines.waitMachine({
        ...target,
        state: "started",
        instance_id: accepted.instance_id,
        timeout: 30,
      });

      const converged = yield* deploy(nextImage);
      expect(converged.machineId).toBe(first.machineId);
      expect(converged.mounts[0]?.volumeId).toBe(first.mounts[0]?.volumeId);
      const observed = yield* machines.getMachine(target);
      expect(observed.instance_id).toBe(accepted.instance_id);
      expect(
        observed.config?.containers?.map(({ name, image }) => ({
          name,
          image,
        })),
      ).toEqual([
        { name: "web", image },
        { name: "sidecar", image: nextImage },
      ]);
      const inventory = (yield* machines.listMachines({
        app_name: first.appName,
      })).filter((machine) => machine.state !== "destroyed");
      expect(inventory.map(({ id }) => id)).toEqual([first.machineId]);
      const volumes = yield* machines.listVolumes({ app_name: first.appName });
      expect(volumes.map(({ id }) => id)).toEqual([first.mounts[0]?.volumeId]);
      yield* stack.destroy();
      const gone = yield* machines.getApp({ app_name: first.appName }).pipe(
        Effect.as(false),
        Effect.catchTag("NotFound", () => Effect.succeed(true)),
      );
      expect(gone).toBe(true);
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider(
  "invalid container groups fail before any Machine is created",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const app = yield* stack.deploy(Fly.App("InvalidContainerSite"));
      const invalid: Array<[string, MachineContainer[]]> = [
        ["empty group", []],
        ["empty image", [{ name: "web", image: "" }]],
        [
          "duplicate names",
          [
            { name: "web", image },
            { name: "web", image: nextImage },
          ],
        ],
        [
          "undeclared dependency",
          [{ name: "web", image, dependsOn: [{ name: "absent" }] }],
        ],
        [
          "exec override",
          // @ts-expect-error Fly accepts container exec without running it
          [{ name: "web", image, exec: ["nginx", "-g", "daemon off;"] }],
        ],
      ];
      for (const [label, containers] of invalid) {
        const failed = yield* stack
          .deploy(
            Effect.gen(function* () {
              const app = yield* Fly.App("InvalidContainerSite");
              return yield* Fly.Machine("Group", {
                app,
                region: "iad",
                guest: { cpus: 1, memoryMb: 256 },
                containers,
              });
            }),
          )
          .pipe(Effect.flip);
        expect(failed, label).toMatchObject({
          _tag: "Fly.InvalidMachineContainers",
        });
      }
      const failed = yield* stack
        .deploy(
          Effect.gen(function* () {
            const app = yield* Fly.App("InvalidContainerSite");
            return yield* Fly.Machine("Group", {
              app,
              region: "iad",
              guest: { cpus: 1, memoryMb: 256 },
              containers: [
                {
                  name: "web",
                  image: "docker-hub-mirror.fly.io/library/nginx:alpine",
                },
              ],
              checks: { ready: { type: "tcp", port: 80 } },
              deploy: { strategy: "bluegreen" },
            });
          }),
        )
        .pipe(Effect.flip);
      expect(failed).toMatchObject({ _tag: "Fly.InvalidDeployment" });
      const live = yield* machines.listMachines({ app_name: app.appName });
      expect(live.filter((machine) => machine.state !== "destroyed")).toEqual(
        [],
      );
      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);
