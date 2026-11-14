import * as Cloudflare from "@alchemy.run/cloudflare";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Containers from "@distilled.cloud/cloudflare/containers";
import * as Workers from "@distilled.cloud/cloudflare/workers";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as HttpClient from "effect/http/HttpClient";
import * as Schedule from "effect/Schedule";
import {
  BuildInputs,
  type BuildInputSet,
  buildSecretsStack,
} from "./fixtures/buildsecrets/stack.ts";
import { GuardWorker } from "./fixtures/native/guard-worker.ts";
import { policyStack, settingsStack, TEST_SSH_PUBLIC_KEY } from "./fixtures/native/settings.ts";
import {
  directEnvStack,
  growingStack,
  NativeImages,
  nativeStack,
} from "./fixtures/native/stack.ts";

/** What `/probe` reports about the running container (fixtures/native). */
interface Probe {
  wasRunning: boolean;
  /** The image reference the object asked to start. */
  configured: string;
  /** The image reference the runtime reports as running. */
  inspected: string | undefined;
  /** `/etc/alpine-release` inside the container. */
  release: string;
  /** Contents of the seeded file, "" when absent. */
  file: string;
  /** The Durable Object storage marker, null when absent. */
  stored: string | null;
}

interface Metadata {
  id: string;
  incarnation: string;
  images: Record<string, string>;
  stored: string | null;
}

interface ExecResult {
  stdout: string;
  exitCode: number;
  /** `/etc/alpine-release` of the running image, "" on non-Alpine images. */
  release: string;
  /** Sorted keys of `ctx.container.images`: the ids of the class's Containers. */
  images: string[];
}

const EFFECT_IMAGES = ["NativeShell", "NativeTools"];
const ASYNC_IMAGES = ["AsyncShell", "AsyncTools"];
// The second class on each Worker shares the Shell Container.
const EFFECT_REVIEWER_IMAGES = ["NativeLint", "NativeShell"];
const ASYNC_REVIEWER_IMAGES = ["AsyncLint", "AsyncShell"];

/** A failed deploy's cause mentions the typed settings conflict. */
const expectSettingsConflict = (exit: Exit.Exit<unknown, unknown>) => {
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit)) {
    const pretty = Cause.pretty(exit.cause);
    expect(pretty).toContain("ContainerApplicationSettingsConflict");
    expect(pretty).toContain("declare different 'observability'");
  }
};

/** GET a route; a non-2xx response fails with its status and body. */
const getText = (baseUrl: string, path: string) =>
  Effect.gen(function* () {
    const response = yield* HttpClient.get(new URL(path, baseUrl));
    const body = yield* response.text;
    if (response.status < 200 || response.status >= 300) {
      return yield* Effect.fail(new Error(`GET ${path} failed (${response.status}): ${body}`));
    }
    return body;
  });

const getJson = <A>(baseUrl: string, path: string) =>
  Effect.map(getText(baseUrl, path), (body) => JSON.parse(body) as A);

/** Fail with the route that hung, so a timeout says which step stalled. */
const within = (path: string, duration: `${number} seconds`) =>
  Effect.timeoutOrElse({
    duration,
    orElse: () => Effect.fail(new Error(`GET ${path} timed out after ${duration}`)),
  });

/**
 * A redeploy reaches requests asynchronously (a new local workerd, or a new
 * Worker version on Cloudflare). Wait until the object observes the deployed
 * image set, which the fixtures expose as their `IMAGE_REVISION`.
 */
const waitForRevision = (url: string, images: object, query = "") => {
  const expected = JSON.stringify(images);
  return getText(url, `/revision${query}`).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (revision) => revision === expected,
      times: 20,
    }),
    within(`/revision${query}`, "30 seconds"),
    Effect.tap((revision) => Effect.sync(() => expect(revision).toBe(expected))),
  );
};

/** A fresh workers.dev URL needs a few seconds before it routes requests. */
const waitUntilReady = (url: string) =>
  getText(url, "/ready").pipe(
    Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 10 }),
    within("/ready", "25 seconds"),
  );

/**
 * Probes start, restart, and write to containers, so they are never retried.
 * Query flags: `seed` writes the marker file and storage, `restart` destroys
 * the running container first, `image=<name>` picks the image to start.
 */
const probe = (url: string, query = "") =>
  getJson<Probe>(url, `/probe${query}`).pipe(within(`/probe${query}`, "25 seconds"));

const readMetadata = (url: string, query = "") =>
  getJson<Metadata>(url, `/metadata${query}`).pipe(within(`/metadata${query}`, "10 seconds"));

/** The image keys a Worker version uploaded for one Durable Object class. */
const uploadedImageKeys = Effect.fn(function* (
  accountId: string,
  scriptName: string,
  className: string,
) {
  const containers = yield* uploadedContainers(accountId, scriptName);
  const entries = containers?.filter((container) => container.className === className) ?? [];
  // One class has exactly one merged entry.
  expect(entries).toHaveLength(1);
  return Object.keys(entries[0]?.images ?? {}).sort();
});

/** The `containers` metadata of a Worker's most recently uploaded version. */
const uploadedContainers = Effect.fn(function* (accountId: string, scriptName: string) {
  const versions = yield* Workers.listScriptVersions({ accountId, scriptName });
  const latest = versions.items?.toSorted((a, b) => (b.number ?? 0) - (a.number ?? 0))[0];
  if (!latest?.id) {
    return yield* Effect.die(`Worker ${scriptName} has no uploaded version.`);
  }
  const version = yield* Workers.getScriptVersion({
    accountId,
    scriptName,
    versionId: latest.id,
  });
  return version.resources.scriptRuntime?.containers;
});

const waitForApplicationDeleted = (accountId: string, applicationId: string) =>
  Containers.getContainerApplication({ accountId, applicationId }).pipe(
    Effect.catchTag("ContainerApplicationNotFound", () => Effect.succeed(undefined)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (application) => application === undefined,
      times: 8,
    }),
  );

for (const dev of [true, false]) {
  describe(
    `Durable Object containers (dev: ${dev})`,
    {
      tags: ["provider:cloudflare", "provider:cloudflare:container", dev ? "local" : "live"],
      // The file's dev sidecar keys running Workers by FQN, so concurrent dev
      // stacks declaring the same Worker would restart each other's instance.
      sequential: dev,
    },
    () => {
      const { test } = Test.make({
        providers: Cloudflare.providers(),
        dev,
        stage: `${Test.defaultStage()}-native-${dev ? "local" : "live"}`,
      });

      // TODO: Investigate image-map propagation after same-key image updates.
      // Live Alpine 3.21 -> 3.20 updates uploaded the correct Worker metadata,
      // but existing DOs still exposed the old ctx.container.images map even
      // after observing the new environment revision. Fresh DOs were mixed:
      // the Effect fixture saw the new map, while the async fixture saw the old.
      // abort() demonstrably recreated both original DOs (new incarnation,
      // same DO ID and preserved storage), but refreshed only the async map.
      // Alpine <-> Debian passed locally and live, including external-image
      // publication. Local Alpine replacement also passed. No root cause yet;
      // eviction alone is not a reliable remedy. Keep these assertions intact.
      (dev ? test.provider : test.provider.todo)(
        "preserves state across redeploys and starts each Container's replaced image",
        (stack) =>
          Effect.gen(function* () {
            yield* stack.destroy();

            const initialImages = { shell: "alpine:3.21", tools: "alpine:3.20" };
            // Swap the two Containers' images.
            const replacementImages = { shell: "alpine:3.20", tools: "alpine:3.21" };
            const stackWith = (images: typeof initialImages) =>
              nativeStack.pipe(Effect.provideService(NativeImages, images));

            /** Seed state into each object, and check both images start. */
            const seed = Effect.fn(function* (url: string) {
              const shell = yield* probe(url, "?seed");
              expect(shell.release).toMatch(/^3\.21\./);
              expect(shell.file).toBe("writable");
              expect(shell.stored).toBe("durable");

              const tools = yield* probe(url, "?restart&image=tools");
              expect(tools.release).toMatch(/^3\.20\./);
              expect(tools.file).toBe("");
              expect(tools.stored).toBe("durable");

              // Leave the shell image running with the seeded file.
              yield* probe(url, "?restart&seed");
            });

            const verifyReplacedImages = Effect.fn(function* (
              worker: { url: string | undefined; workerName: string },
              shellImage: string | undefined,
            ) {
              const url = worker.url!;

              // Wait for the new Worker version to reach this object.
              const expectedRevision = JSON.stringify(replacementImages);
              const revision = yield* getText(url, "/revision").pipe(
                Effect.repeat({
                  schedule: Schedule.spaced("1 second"),
                  until: (value) => value === expectedRevision,
                  times: 8,
                }),
                Effect.timeout("15 seconds"),
              );
              expect(revision).toBe(expectedRevision);

              const existing = yield* readMetadata(url);
              const fresh = yield* readMetadata(url, "?object=fresh-after-update");
              yield* Effect.logInfo("Image metadata before eviction", {
                worker: worker.workerName,
                expected: shellImage,
                existing,
                fresh,
              });

              // abort() fails the request by design; a new incarnation on
              // the next read proves the object was evicted.
              yield* getText(url, "/evict").pipe(Effect.ignore);
              const evicted = yield* readMetadata(url).pipe(
                Effect.retry({
                  schedule: Schedule.spaced("1 second"),
                  times: 3,
                }),
              );
              expect(evicted.id).toBe(existing.id);
              expect(evicted.incarnation).not.toBe(existing.incarnation);
              expect(evicted.stored).toBe("durable");
              expect(fresh.id).not.toBe(existing.id);
              expect(fresh.stored).toBeNull();

              // Updating declarations must not replace a running container.
              // Local hot reload restarts workerd, so only production keeps
              // the running container.
              const beforeRestart = yield* probe(url);
              expect(beforeRestart.stored).toBe("durable");
              if (!dev) {
                expect(beforeRestart.configured).toBe(shellImage);
                expect(beforeRestart).toMatchObject({
                  wasRunning: true,
                  release: expect.stringMatching(/^3\.21\./),
                  file: "writable",
                  stored: "durable",
                });
              }

              // A restart picks up the Container's replaced image.
              const afterRestart = yield* probe(url, "?restart");
              if (!dev) {
                expect(afterRestart.inspected).toBe(afterRestart.configured);
              }
              expect(afterRestart.release).toMatch(/^3\.20\./);
              expect(afterRestart.file).toBe("");
              expect(afterRestart.stored).toBe("durable");

              const tools = yield* probe(url, "?restart&image=tools");
              expect(tools.release).toMatch(/^3\.21\./);
              expect(tools.stored).toBe("durable");
            });

            yield* Effect.gen(function* () {
              const initial = yield* stack.deploy(stackWith(initialImages));
              const initialWorkers = [initial.worker, initial.asyncWorker];
              for (const worker of initialWorkers) {
                yield* waitUntilReady(worker.url!);
              }
              yield* Effect.forEach(initialWorkers, (worker) => seed(worker.url!), {
                concurrency: 2,
              });

              // An unchanged redeploy keeps the running container and state.
              const unchanged = yield* stack.deploy(stackWith(initialImages));
              for (const worker of [unchanged.worker, unchanged.asyncWorker]) {
                expect(yield* probe(worker.url!)).toMatchObject({
                  wasRunning: true,
                  release: expect.stringMatching(/^3\.21\./),
                  file: "writable",
                  stored: "durable",
                });
              }

              // Replacing images exercises external-image publication on update.
              const changed = yield* stack.deploy(stackWith(replacementImages));
              expect(changed.application.applicationId).toBe(initial.application.applicationId);
              expect(changed.asyncApplication.applicationId).toBe(
                initial.asyncApplication.applicationId,
              );
              // Local bindings expose Container ids; cloud bindings expose digests.
              if (!dev) {
                expect(changed.shell.image).not.toBe(initial.shell.image);
                expect(changed.tools.image).not.toBe(initial.tools.image);
              }
              yield* Effect.all(
                [
                  verifyReplacedImages(changed.worker, changed.shell.image),
                  verifyReplacedImages(changed.asyncWorker, changed.asyncShell.image),
                ],
                { concurrency: 2 },
              );
            }).pipe(Effect.ensuring(stack.destroy().pipe(Effect.orDie)));
          }),
        { timeout: 120_000, retry: 0 },
      );

      test.provider(
        "rejects a Durable Object-managed Container placed directly in env",
        (stack) =>
          Effect.gen(function* () {
            yield* stack.destroy();
            const exit = yield* stack.deploy(directEnvStack).pipe(Effect.exit);
            expect(Exit.isFailure(exit)).toBe(true);
            if (Exit.isFailure(exit)) {
              const pretty = Cause.pretty(exit.cause);
              expect(pretty).toContain("DurableObjectContainerBindingError");
              expect(pretty).toContain(
                'Cloudflare.DurableObject("SANDBOX", { containers: [AsyncShell] })',
              );
            }
            yield* stack.destroy();
          }),
        { timeout: 60_000, retry: 0 },
      );

      test.provider(
        "rejects containers on the binding of an Effect-native Durable Object class",
        (stack) =>
          Effect.gen(function* () {
            yield* stack.destroy();
            const exit = yield* stack
              .deploy(
                Effect.gen(function* () {
                  return yield* GuardWorker;
                }),
              )
              .pipe(Effect.exit);
            expect(Exit.isFailure(exit)).toBe(true);
            if (Exit.isFailure(exit)) {
              const pretty = Cause.pretty(exit.cause);
              expect(pretty).toContain("DurableObjectContainersOnEffectNativeClass");
              expect(pretty).toContain("yield*");
            }
            yield* stack.destroy();
          }),
        { timeout: 120_000, retry: 0 },
      );

      // Settings conflicts fail the plan, before anything is published.
      test.provider(
        "rejects Containers of one class that declare different application settings",
        (stack) =>
          Effect.gen(function* () {
            yield* stack.destroy();
            const conflicting = yield* stack
              .deploy(
                settingsStack(
                  { observability: { logs: { enabled: true } } },
                  { observability: { logs: { enabled: false } } },
                ),
              )
              .pipe(Effect.exit);
            expectSettingsConflict(conflicting);
            yield* stack.destroy();
          }),
        // The deploy fails fast but returns only once its sibling Containers'
        // images finish building and pushing, which can take minutes.
        { timeout: 180_000, retry: 0 },
      );

      if (!dev) {
        const observe = (application: { accountId: string; applicationId: string }) =>
          Containers.getContainerApplication({
            accountId: application.accountId,
            applicationId: application.applicationId,
          });

        test.provider(
          "manages SSH, authorized keys, and observability declared by any of the class's Containers",
          (stack) =>
            Effect.gen(function* () {
              yield* stack.destroy();
              yield* Effect.gen(function* () {
                // `ssh`/`authorizedKeys` on one Container, `observability` on
                // the other: the class's application merges both.
                const declared = yield* stack.deploy(
                  settingsStack(
                    {
                      ssh: { enabled: true, port: 22 },
                      authorizedKeys: [{ name: "alchemy-test", publicKey: TEST_SSH_PUBLIC_KEY }],
                    },
                    { observability: { logs: { enabled: true } } },
                  ),
                );
                const application = declared.application;
                const withSettings = yield* observe(application);
                expect(withSettings.id).toBe(
                  declared.worker.durableObjectNamespaces.NativeAsyncObject,
                );
                expect(withSettings.configuration?.wranglerSsh).toMatchObject({
                  enabled: true,
                  port: 22,
                });
                expect(
                  withSettings.configuration?.authorizedKeys?.map((key) => key.publicKey),
                ).toEqual([TEST_SSH_PUBLIC_KEY]);
                expect(withSettings.observability?.logs?.enabled).toBe(true);

                // Removing declarations clears what this stack managed.
                const removed = yield* stack.deploy(settingsStack());
                expect(removed.application.applicationId).toBe(application.applicationId);
                const cleared = yield* observe(application);
                expect(cleared.configuration?.wranglerSsh?.enabled ?? false).toBe(false);
                expect(cleared.configuration?.authorizedKeys ?? []).toEqual([]);
                expect(cleared.observability?.logs?.enabled ?? false).toBe(false);

                // Settings this stack never declared are left alone.
                yield* Containers.updateContainerApplication({
                  accountId: application.accountId,
                  applicationId: application.applicationId,
                  configuration: { wranglerSsh: { enabled: true, port: 22 } },
                });
                yield* stack.deploy(settingsStack());
                expect((yield* observe(application)).configuration?.wranglerSsh?.enabled).toBe(
                  true,
                );
              }).pipe(Effect.ensuring(stack.destroy().pipe(Effect.orDie)));
            }),
          { timeout: 180_000, retry: 0 },
        );

        test.provider(
          "rejects switching an application between fleet and Durable Object scheduling",
          (stack) =>
            Effect.gen(function* () {
              yield* stack.destroy();
              yield* Effect.gen(function* () {
                const fleet = yield* stack.deploy(policyStack("default"));
                const switched = yield* stack
                  .deploy(policyStack("durable_object"))
                  .pipe(Effect.exit);
                expect(Exit.isFailure(switched)).toBe(true);
                if (Exit.isFailure(switched)) {
                  expect(Cause.pretty(switched.cause)).toContain(
                    "cannot switch between fleet and Durable Object scheduling",
                  );
                }
                // The rejected deploy did not touch the deployed application.
                const observed = yield* observe(fleet);
                expect(observed.id).toBe(fleet.applicationId);
                expect(observed.schedulingPolicy).toBe("default");
              }).pipe(Effect.ensuring(stack.destroy().pipe(Effect.orDie)));
            }),
          { timeout: 120_000, retry: 0 },
        );
      }

      // The second deploy uploads the Worker with a namespace for the new
      // class; its container application must be created in that same deploy.
      test.provider(
        "a deployed Worker gains a container-backed class in one deploy",
        (stack) =>
          Effect.gen(function* () {
            yield* stack.destroy();

            yield* stack.deploy(growingStack(false));
            const grown = yield* stack.deploy(growingStack(true));

            const application = grown.reviewerApplication!;
            if (!dev) {
              const observed = yield* Containers.getContainerApplication({
                accountId: application.accountId,
                applicationId: application.applicationId,
              });
              expect(observed.id).toBe(grown.worker.durableObjectNamespaces.NativeAsyncReviewer);
              expect(observed.durableObjects?.namespaceId).toBe(observed.id);
            }

            const url = grown.worker.url!;
            yield* waitUntilReady(url);
            const reviewer = yield* getJson<ExecResult>(url, "/exec?class=reviewer").pipe(
              within(`${url}/exec?class=reviewer`, "10 seconds"),
              Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 40 }),
              within(`${url}/exec?class=reviewer`, "120 seconds"),
            );
            expect(reviewer).toEqual({
              stdout: "native",
              exitCode: 7,
              release: expect.stringMatching(/^3\.21\./),
              images: ASYNC_REVIEWER_IMAGES,
            });

            yield* stack.destroy();
          }),
        { timeout: 180_000, retry: 0 },
      );

      for (const scenario of ["execution", "membership"] as const) {
        test.provider(
          scenario === "execution"
            ? "starts each bound Container's image from Effect and async Durable Objects"
            : "adds and removes a class's Containers without replacing its application",
          (stack) =>
            Effect.gen(function* () {
              yield* stack.destroy();

              /**
               * Exec and lifecycle routes are safe to repeat. Right after a deploy,
               * a workers.dev route can 404 or drop a request, and a Durable Object
               * can still be served the pre-create placeholder ("Alchemy worker is
               * being deployed") until the new version reaches it. Each attempt is
               * bounded and retried for up to two minutes.
               */
              const call = <A>(url: string, path: string) =>
                getJson<A>(url, path).pipe(
                  within(`${url}${path}`, "10 seconds"),
                  Effect.tapError((error) =>
                    Effect.logWarning(`${url}${path} attempt failed`, error),
                  ),
                  Effect.retry({
                    schedule: Schedule.spaced("2 seconds"),
                    times: 40,
                  }),
                  within(`${url}${path}`, "120 seconds"),
                );
              const exec = (url: string, path: string) => call<ExecResult>(url, path);

              const applications = yield* Effect.gen(function* () {
                const deployed = yield* stack.deploy(nativeStack);

                if (scenario === "execution") {
                  for (const [worker, images] of [
                    [deployed.asyncWorker, ASYNC_IMAGES],
                    [deployed.worker, EFFECT_IMAGES],
                  ] as const) {
                    const url = worker.url!;
                    yield* waitUntilReady(url);
                    // Each handle's start() starts its own Container's image.
                    expect(yield* exec(url, "/exec")).toEqual({
                      stdout: "native",
                      exitCode: 7,
                      release: expect.stringMatching(/^3\.21\./),
                      images,
                    });
                    expect(yield* exec(url, "/image/tools")).toEqual({
                      stdout: "native",
                      exitCode: 7,
                      release: expect.stringMatching(/^3\.20\./),
                      images,
                    });
                    expect(yield* exec(url, "/stdin")).toEqual({
                      stdout: "native stdin",
                      exitCode: 0,
                      release: expect.stringMatching(/^3\.21\./),
                      images,
                    });
                  }
                  expect(yield* exec(deployed.worker.url!, "/snapshot")).toEqual({
                    stdout: "persisted",
                    exitCode: 0,
                    release: expect.stringMatching(/^3\.21\./),
                    images: EFFECT_IMAGES,
                  });

                  // Closing an exec's scope kills the process; stdout streams;
                  // a failed container surfaces as ContainerError from monitor().
                  const lifecycle = (mode: string) =>
                    call<Record<string, unknown>>(deployed.worker.url!, `/lifecycle/${mode}`);
                  expect(yield* lifecycle("interrupt")).toEqual({ remaining: "" });
                  expect(yield* lifecycle("stream")).toEqual({ stdout: "ab" });
                  expect(yield* lifecycle("monitor")).toEqual({
                    failed: true,
                    tag: "ContainerError",
                  });
                  // The container's outbound HTTP reaches the Worker entrypoint.
                  expect(yield* lifecycle("intercept")).toEqual({
                    exitCode: 0,
                    stdout: "intercepted intercept.internal/hello",
                    stderr: "",
                  });

                  // A second class on each Worker shares the Shell Container
                  // and starts its own images from its own image map.
                  for (const [path, release] of [
                    ["/reviewer/shell", /^3\.21\./],
                    ["/reviewer/lint", /^3\.19\./],
                  ] as const) {
                    expect(yield* exec(deployed.worker.url!, path)).toEqual({
                      stdout: "native",
                      exitCode: 7,
                      release: expect.stringMatching(release),
                      images: EFFECT_REVIEWER_IMAGES,
                    });
                  }
                  for (const [path, release] of [
                    ["/exec?class=reviewer", /^3\.21\./],
                    ["/image/lint?class=reviewer", /^3\.19\./],
                  ] as const) {
                    expect(yield* exec(deployed.asyncWorker.url!, path)).toEqual({
                      stdout: "native",
                      exitCode: 7,
                      release: expect.stringMatching(release),
                      images: ASYNC_REVIEWER_IMAGES,
                    });
                  }

                  // Containers own images, not applications.
                  for (const container of [
                    deployed.shell,
                    deployed.tools,
                    deployed.lint,
                    deployed.asyncShell,
                  ]) {
                    expect(container.applicationId).toEqual(
                      dev ? expect.stringMatching(/^dev:/) : "",
                    );
                  }

                  if (dev) {
                    // Local emulation never creates a cloud application.
                    for (const application of [
                      deployed.application,
                      deployed.reviewerApplication,
                      deployed.asyncApplication,
                      deployed.asyncReviewerApplication,
                    ]) {
                      expect(application.applicationId).toMatch(/^dev:/);
                    }
                  }

                  if (!dev) {
                    // One application per class, attached to its namespace,
                    // without any fleet configuration.
                    const classes = [
                      [deployed.application, deployed.worker, "NativeObject", EFFECT_IMAGES],
                      [
                        deployed.reviewerApplication,
                        deployed.worker,
                        "NativeReviewer",
                        EFFECT_REVIEWER_IMAGES,
                      ],
                      [
                        deployed.asyncApplication,
                        deployed.asyncWorker,
                        "NativeAsyncObject",
                        ASYNC_IMAGES,
                      ],
                      [
                        deployed.asyncReviewerApplication,
                        deployed.asyncWorker,
                        "NativeAsyncReviewer",
                        ASYNC_REVIEWER_IMAGES,
                      ],
                    ] as const;
                    // Every class has its own application.
                    expect(
                      new Set(classes.map(([application]) => application.applicationId)).size,
                    ).toBe(classes.length);
                    for (const [application, worker, className, images] of classes) {
                      const observed = yield* Containers.getContainerApplication({
                        accountId: application.accountId,
                        applicationId: application.applicationId,
                      });
                      expect(observed.schedulingPolicy).toBe("durable_object");
                      expect(observed.id).toBe(worker.durableObjectNamespaces[className]);
                      expect(observed.id).toBe(observed.durableObjects?.namespaceId);
                      expect(observed.name).toBe(application.applicationName);
                      const { configuration } = observed;
                      expect(
                        configuration && "image" in configuration ? configuration.image : undefined,
                      ).toBeUndefined();
                      expect(
                        "maxInstances" in observed
                          ? (observed.maxInstances ?? undefined)
                          : undefined,
                      ).toBeUndefined();
                      // The uploaded Worker merges the class's Containers into
                      // its one entry, keyed by Container id.
                      expect(
                        yield* uploadedImageKeys(
                          application.accountId,
                          worker.workerName,
                          className,
                        ),
                      ).toEqual(images);
                    }
                    expect(yield* exec(deployed.asyncWorker.url!, "/builtin")).toEqual({
                      stdout: "native",
                      exitCode: 7,
                      release: "",
                      images: ASYNC_IMAGES,
                    });
                  }

                  const unchanged = yield* stack.deploy(nativeStack);
                  expect(unchanged.application.applicationId).toBe(
                    deployed.application.applicationId,
                  );
                  expect(unchanged.asyncApplication.applicationId).toBe(
                    deployed.asyncApplication.applicationId,
                  );
                } else {
                  yield* waitUntilReady(deployed.asyncWorker.url!);
                  expect(yield* exec(deployed.asyncWorker.url!, "/image/tools")).toMatchObject({
                    release: expect.stringMatching(/^3\.20\./),
                    images: ASYNC_IMAGES,
                  });

                  // Removing a Container drops its image from the class.
                  const removedImages = { shell: "alpine:3.21", tools: undefined };
                  const removed = yield* stack.deploy(
                    nativeStack.pipe(Effect.provideService(NativeImages, removedImages)),
                  );
                  expect(removed.asyncApplication.applicationId).toBe(
                    deployed.asyncApplication.applicationId,
                  );
                  expect(removed.tools.image).toBeUndefined();
                  if (!dev) {
                    expect(
                      yield* uploadedImageKeys(
                        removed.asyncApplication.accountId,
                        removed.asyncWorker.workerName,
                        "NativeAsyncObject",
                      ),
                    ).toEqual(["AsyncShell"]);
                    expect(
                      yield* uploadedImageKeys(
                        removed.application.accountId,
                        removed.worker.workerName,
                        "NativeObject",
                      ),
                    ).toEqual(["NativeShell"]);
                  }
                  // TODO: Live image-map updates reach existing Workers
                  // inconsistently: a redeploy's version can take longer than
                  // a bounded wait to serve, and existing objects can keep
                  // the old map. Live coverage asserts the uploaded metadata
                  // above; the runtime view is asserted locally.
                  if (dev) {
                    // A redeploy cuts over to the new Worker version
                    // asynchronously; wait for it before observing the class.
                    yield* waitForRevision(
                      removed.asyncWorker.url!,
                      removedImages,
                      "?object=removed",
                    );
                    yield* waitForRevision(removed.worker.url!, removedImages);
                    expect(yield* exec(removed.asyncWorker.url!, "/exec?object=removed")).toEqual({
                      stdout: "native",
                      exitCode: 7,
                      release: expect.stringMatching(/^3\.21\./),
                      images: ["AsyncShell"],
                    });
                    expect(yield* exec(removed.worker.url!, "/exec")).toMatchObject({
                      images: ["NativeShell"],
                    });
                  }

                  // Adding it back restores the image under the same key.
                  const added = yield* stack.deploy(nativeStack);
                  expect(added.asyncApplication.applicationId).toBe(
                    deployed.asyncApplication.applicationId,
                  );
                  if (!dev) {
                    expect(
                      yield* uploadedImageKeys(
                        added.asyncApplication.accountId,
                        added.asyncWorker.workerName,
                        "NativeAsyncObject",
                      ),
                    ).toEqual(ASYNC_IMAGES);
                  } else {
                    yield* waitForRevision(
                      added.asyncWorker.url!,
                      { shell: "alpine:3.21", tools: "alpine:3.20" },
                      "?object=added",
                    );
                    expect(
                      yield* exec(added.asyncWorker.url!, "/image/tools?object=added"),
                    ).toEqual({
                      stdout: "native",
                      exitCode: 7,
                      release: expect.stringMatching(/^3\.20\./),
                      images: ASYNC_IMAGES,
                    });
                  }
                }
                return [deployed.application, deployed.asyncApplication];
              }).pipe(Effect.ensuring(stack.destroy().pipe(Effect.orDie)));

              if (!dev) {
                for (const application of applications) {
                  expect(
                    yield* waitForApplicationDeleted(
                      application.accountId,
                      application.applicationId,
                    ),
                  ).toBeUndefined();
                }
              }
            }),
          { timeout: 300_000, retry: 0 },
        );
      }

      test.provider(
        "builds a Container's Dockerfile with build args and BuildKit secrets",
        (stack) =>
          Effect.gen(function* () {
            yield* stack.destroy();

            const withInputs = (inputs: BuildInputSet) =>
              buildSecretsStack.pipe(Effect.provideService(BuildInputs, inputs));
            const initial = { greeting: "hello", token: "alchemy-build-secret-value" };

            const application = yield* Effect.gen(function* () {
              const deployed = yield* stack.deploy(withInputs(initial));
              const url = deployed.worker.url!;
              yield* waitUntilReady(url);
              // The build saw the arg and the secret's mount.
              expect(
                yield* getText(url, "/build").pipe(
                  within("/build", "10 seconds"),
                  Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 40 }),
                ),
              ).toBe(`hello ${initial.token.length}`);

              // Secrets compare by value, so an unchanged program plans nothing.
              const unchanged = yield* stack.plan(withInputs(initial));
              expect(unchanged.resources.BuildSecretsImage?.action).toBe("noop");

              // Rotating a secret reuses the published image.
              const rotated = yield* stack.deploy(withInputs({ ...initial, token: "rotated" }));
              expect(rotated.image.hash?.image).toBe(deployed.image.hash?.image);
              expect(rotated.image.image).toBe(deployed.image.image);

              // A build arg is part of the image's content hash.
              const changed = yield* stack.deploy(
                withInputs({ greeting: "howdy", token: "rotated" }),
              );
              expect(changed.image.hash?.image).not.toBe(deployed.image.hash?.image);
              return deployed.application;
            }).pipe(Effect.ensuring(stack.destroy().pipe(Effect.orDie)));

            if (!dev) {
              expect(
                yield* waitForApplicationDeleted(application.accountId, application.applicationId),
              ).toBeUndefined();
            }
          }),
        { timeout: 300_000, retry: 0 },
      );
    },
  );
}
