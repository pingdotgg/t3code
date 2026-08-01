import * as Containers from "@distilled.cloud/cloudflare/containers";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { AlchemyContext } from "../../AlchemyContext.ts";
import { getStableContextDir } from "../../Bundle/TempRoot.ts";
import { hashDirectory } from "../../Command/Memo.ts";
import { deepEqual, isResolved } from "../../Diff.ts";
import { Docker } from "../../Docker/Docker.ts";
import * as Provider from "../../Provider.ts";
import { type ResourceBinding } from "../../Resource.ts";
import { sha256Object } from "../../Util/sha256.ts";
import { normalizeNulls } from "../../Util/stable.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import { isLiveId } from "../LocalRuntime.ts";
import { CloudflareLogs, type TelemetryFilter } from "../Logs.ts";
import type {
  AnyContainerApplicationProps,
  ContainerApplication,
} from "./ContainerApplication.ts";
import { isInlineDockerfile } from "../../Docker/Dockerfile.ts";
import {
  buildFinalDockerfile,
  bundleContainerProgram,
  containerEnvPreamble,
  createContainerApplicationName,
  makeContainerEnv,
  materializeInlineDockerfileContext,
  validateContainerImageProps,
} from "./ContainerBundle.ts";
import { ContainerPlatform } from "./ContainerPlatform.ts";

/**
 * The image source resolved from a {@link ContainerApplicationProps}. Selects
 * one of three strategies used by `buildAndPushImage`:
 *
 * - `effectful` — bundle an Effect-native `main` and build a generated image.
 * - `external` — build a user-supplied Dockerfile against a context directory.
 * - `remote` — pull a pre-built remote image and re-push it to Cloudflare.
 */
type ImageBuild =
  | {
      readonly kind: "effectful";
      readonly files: ReadonlyArray<{ path: string; content: Uint8Array }>;
    }
  | {
      readonly kind: "external";
      readonly context: string;
      readonly dockerfile: string;
    }
  | {
      readonly kind: "remote";
      readonly image: string;
    };

export const LiveContainerProvider = () =>
  Provider.effect(
    ContainerPlatform,
    Effect.gen(function* () {
      const { dotAlchemy } = yield* AlchemyContext;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const docker = yield* Docker;

      const telemetry = yield* CloudflareLogs;

      const createApplicationName = createContainerApplicationName;

      const findApplicationByName = Effect.fn(function* (name: string) {
        const { accountId } = yield* yield* CloudflareEnvironment;

        return yield* Containers.listContainerApplications({ accountId }).pipe(
          Effect.map((apps) => apps.find((app) => app.name === name)),
        );
      });

      const findApplicationByNamespace = Effect.fn(function* (
        namespaceId: string,
      ) {
        const { accountId } = yield* yield* CloudflareEnvironment;

        return yield* Containers.listContainerApplications({ accountId }).pipe(
          Effect.map((apps) =>
            apps.find((app) => app.durableObjects?.namespaceId === namespaceId),
          ),
        );
      });

      // After deleting an application by id, Cloudflare's account-scoped
      // `list` endpoint stays eventually-consistent for a short window and can
      // keep returning the now-deleted row. A subsequent recreate that
      // re-discovers the application by name (`createApplication`) would then
      // "adopt" that stale row and try to UPDATE it — which fails permanently
      // with `ContainerApplicationNotFound` (the app is really gone) and
      // exhausts the readiness retry. Block until the deleted id no longer
      // appears under that name (or a different id has taken the name, i.e. a
      // concurrent recreate) before proceeding. Bounded by the readiness
      // schedule; if it never clears we fall through and let create handle it.
      const waitForApplicationDeleted = (name: string, deletedId: string) =>
        findApplicationByName(name).pipe(
          Effect.repeat({
            schedule: containerApplicationReadinessSchedule,
            until: (app) => app?.id !== deletedId,
          }),
          Effect.asVoid,
        );

      const desiredConfiguration = (
        props: AnyContainerApplicationProps,
        env: Record<string, string | Redacted.Redacted<string>>,
        imageRef: string,
      ) =>
        normalizeNulls({
          image: imageRef,
          // Default to wrangler's instance type ("lite") so containers schedule
          // the same way out of the box. `instance_type` is mutually exclusive
          // with explicit vcpu/memory/disk, so only default it when none are
          // set. ("dev" is wrangler's deprecated alias for "lite".)
          instanceType:
            props.instanceType ??
            (props.vcpu === undefined &&
            props.memory === undefined &&
            props.disk === undefined
              ? "lite"
              : undefined),
          observability: props.observability,
          sshPublicKeyIds: props.sshPublicKeyIds,
          secrets: props.secrets,
          vcpu: props.vcpu,
          memory: props.memory,
          disk: props.disk,
          environmentVariables: Object.entries(env).map(([name, value]) => ({
            name,
            value: Redacted.isRedacted(value) ? Redacted.value(value) : value,
          })),
          labels: props.labels,
          network: props.network,
          command: props.command,
          entrypoint: props.entrypoint,
          dns: props.dns,
          ports: props.ports,
          checks: props.checks,
        }) as ContainerApplication.Configuration;

      // Scaling/placement defaults mirror wrangler's container defaults
      // (`wrangler-dist/cli.js`) so an Alchemy container behaves like a
      // `wrangler deploy`d one without extra config:
      //   - max_instances: 20            (`container.max_instances ?? 20`)
      //   - instances: 0                 (wrangler forces 0 whenever
      //                                    max_instances is set, which we always
      //                                    do — pure scale-from-zero)
      //   - scheduling_policy: "default"
      // (wrangler also defaults `constraints.tiers` to `[1, 2]`, but the
      // distilled SDK models constraints as singular `tier`, not the `tiers`
      // array, so we leave constraints untouched — it's a minor placement hint
      // next to the scaling defaults.)
      // A maxInstances default of 1 (the previous value) silently serialised
      // every Durable Object instance through a single container slot, which is
      // the dominant cause of "containers are slow under load".
      const scalingDefaults = (props: AnyContainerApplicationProps) => ({
        instances: props.instances ?? 0,
        maxInstances: props.maxInstances ?? 20,
        schedulingPolicy: props.schedulingPolicy ?? "default",
        constraints: props.constraints ?? {},
      });

      const computeImage = Effect.fn(function* (
        id: string,
        props: AnyContainerApplicationProps,
        env: Record<string, string | Redacted.Redacted<string>>,
      ) {
        const { accountId } = yield* yield* CloudflareEnvironment;
        const name = yield* createApplicationName(id, props.name);
        const registryId = props.registryId ?? "registry.cloudflare.com";
        const repositoryName = name.toLowerCase();
        const makeRef = (imageHash: string) =>
          `${registryId}/${accountId}/${repositoryName}:${imageHash}`;

        yield* validateContainerImageProps(props);

        // Variant 1 — Effect-native program. Bundle `main` and build a
        // generated Dockerfile around it; the environment preamble comes
        // from `image` / inline `dockerfile` (default: the runtime base).
        if (props.main) {
          const runtime = props.runtime ?? "bun";
          const { files, hash: bundleHash } = yield* bundleContainerProgram({
            id,
            main: props.main,
            runtime,
            handler: props.handler,
            isExternal: props.isExternal,
            external: props.external,
          });
          const finalDockerfile = buildFinalDockerfile(
            yield* containerEnvPreamble(props),
            runtime,
            props.external,
            props.autoInstallExternals,
          );
          const imageHash = (yield* sha256Object({
            bundleHash,
            dockerfile: finalDockerfile,
          })).slice(0, 16);
          // The dev image is the deterministic build-context directory that
          // `buildAndPushImage` materializes into (and that the local provider
          // regenerates on the next `alchemy dev`). We persist the path here so
          // a dev run after a live deploy has an image to `docker build` — the
          // live deploy pushes to Cloudflare's registry, which the local
          // `workerd` runtime can't pull. See `prepareContainerBuildContext`.
          const contextDir = yield* getStableContextDir(
            process.cwd(),
            dotAlchemy,
            `${id}-container`,
          );
          return {
            build: { kind: "effectful" as const, files },
            imageRef: makeRef(imageHash),
            imageHash,
            dev: {
              context: path.relative(process.cwd(), contextDir),
              dockerfile: "Dockerfile",
              env,
            },
          };
        }

        // Variant 2 — pre-built remote image. The image reference is the
        // identity; we pull and re-push it without building anything.
        if (props.image) {
          const imageHash = (yield* sha256Object({
            image: props.image,
          })).slice(0, 16);
          return {
            build: { kind: "remote" as const, image: props.image },
            imageRef: makeRef(imageHash),
            imageHash,
            // The local runtime pulls this image directly (no build context).
            dev: { imageUri: props.image, env },
          };
        }

        // Variant 3a — inline Dockerfile content (`Dockerfile.inline`), no
        // build context. Materialize the content into a stable generated
        // context directory and build that.
        if (
          props.dockerfile !== undefined &&
          isInlineDockerfile(props.dockerfile)
        ) {
          const content = props.dockerfile.content;
          if (typeof content !== "string") {
            return yield* Effect.die(
              new Error(
                "Inline `dockerfile` content is an unresolved Output at image-build time — its dependencies have not resolved yet (e.g. during precreate of a circular binding). Break the cycle or inline the resolved value.",
              ),
            );
          }
          const { context, dockerfile } =
            yield* materializeInlineDockerfileContext(id, content);
          const imageHash = (yield* sha256Object({
            dockerfile: content,
          })).slice(0, 16);
          return {
            build: { kind: "external" as const, context, dockerfile },
            imageRef: makeRef(imageHash),
            imageHash,
            // The local runtime builds the same materialized context.
            dev: {
              context: path.relative(process.cwd(), context),
              dockerfile: "Dockerfile",
              env,
            },
          };
        }

        // Variant 3b — user-supplied Dockerfile path + build context
        // directory.
        const context = yield* fs.realPath(props.context ?? ".");
        const dockerfile = props.dockerfile
          ? yield* fs.realPath(props.dockerfile)
          : path.join(context, "Dockerfile");
        const contextHash = yield* hashDirectory({ cwd: context });
        const dockerfileContent = yield* fs.readFileString(dockerfile);
        const imageHash = (yield* sha256Object({
          contextHash,
          dockerfile: dockerfileContent,
        })).slice(0, 16);
        return {
          build: { kind: "external" as const, context, dockerfile },
          imageRef: makeRef(imageHash),
          imageHash,
          // The local runtime builds the user's Dockerfile against the same
          // (already real-path'd) context directory.
          dev: {
            context: path.relative(process.cwd(), context),
            dockerfile: path.relative(context, dockerfile),
            env,
          },
        };
      });

      const buildAndPushImage = Effect.fn(function* (
        id: string,
        props: AnyContainerApplicationProps,
        build: ImageBuild,
        imageRef: string,
        session?: { note: (message: string) => Effect.Effect<void> },
      ) {
        const { accountId } = yield* yield* CloudflareEnvironment;
        const platform = "linux/amd64";

        if (build.kind === "remote") {
          // Pull the pre-built image and re-tag it to the Cloudflare registry
          // reference; nothing is built locally.
          yield* Effect.logInfo(
            `Cloudflare Container image: pulling ${build.image}`,
          );
          if (session) {
            yield* session.note(`Pulling container image ${build.image}...`);
          }
          yield* docker.image.pull(build.image, platform);
          yield* docker.image.tag(build.image, imageRef);
        } else if (build.kind === "external") {
          // Build the user's Dockerfile directly against their context dir so
          // relative `COPY`/`ADD` paths resolve as the author intended.
          yield* Effect.logInfo(
            `Cloudflare Container image: building ${imageRef}`,
          );
          if (session) {
            yield* session.note(`Building container image ${imageRef}...`);
          }
          yield* docker.image.build({
            tag: imageRef,
            context: build.context,
            platform,
            file: build.dockerfile,
          });
        } else {
          // Effect-native program: materialize the generated Dockerfile and
          // bundled chunks into a stable staging dir, then build.
          yield* Effect.logInfo(
            `Cloudflare Container image: building ${imageRef}`,
          );
          if (session) {
            yield* session.note(`Building container image ${imageRef}...`);
          }
          const runtime = props.runtime ?? "bun";
          const contextDir = yield* getStableContextDir(
            process.cwd(),
            dotAlchemy,
            `${id}-container`,
          );
          const finalDockerfile = buildFinalDockerfile(
            yield* containerEnvPreamble(props),
            runtime,
            props.external,
            props.autoInstallExternals,
          );
          yield* docker.materialize({
            context: contextDir,
            dockerfile: finalDockerfile,
            files: build.files.map((f, i) => ({
              path: i === 0 ? "index.mjs" : f.path,
              content: f.content,
            })),
          });
          yield* docker.image.build({
            tag: imageRef,
            context: contextDir,
            platform,
          });
        }

        yield* Effect.logInfo(
          `Cloudflare Container image: pushing ${imageRef}`,
        );
        if (session) {
          yield* session.note(`Pushing container image ${imageRef}...`);
        }

        const registryId = props.registryId ?? "registry.cloudflare.com";
        const credentials =
          yield* Containers.createContainerRegistryCredentials({
            accountId,
            registryId,
            permissions: ["pull", "push"],
            expirationMinutes: 60,
          });
        const username = credentials.username ?? (credentials as any).user;
        if (!username) {
          return yield* Effect.fail(
            new Error(
              "Cloudflare registry credentials did not include a username.",
            ),
          );
        }

        yield* docker.image.push(imageRef, {
          username,
          password: credentials.password,
          server: registryId,
        });
      });

      const maybeCreateRollout = Effect.fn(function* ({
        applicationId,
        configuration,
        rollout,
      }: {
        applicationId: string;
        configuration: ContainerApplication.Configuration;
        rollout: ContainerApplication.Rollout | undefined;
      }) {
        const { accountId } = yield* yield* CloudflareEnvironment;

        const strategy = rollout?.strategy ?? "immediate";
        const stepPercentage =
          strategy === "immediate" ? 100 : (rollout?.stepPercentage ?? 25);

        yield* retryForContainerApplicationReadiness(
          "rollout",
          applicationId,
          Containers.createContainerApplicationRollout({
            accountId,
            applicationId,
            description:
              strategy === "immediate"
                ? "Immediate update"
                : "Progressive update",
            strategy: "rolling",
            kind: rollout?.kind ?? "full_auto",
            stepPercentage,
            targetConfiguration: configuration,
          }),
        );
      });

      const createApplication = Effect.fn(function* ({
        id,
        news,
        name,
        configuration,
        durableObjects,
        session,
      }: {
        id: string;
        news: AnyContainerApplicationProps;
        name: string;
        configuration: ContainerApplication.Configuration;
        durableObjects:
          | {
              namespaceId: string;
            }
          | undefined;
        session: { note: (message: string) => Effect.Effect<void> };
      }) {
        const { accountId } = yield* yield* CloudflareEnvironment;

        const describeError = (error: unknown) => {
          if (error instanceof Error) {
            return JSON.stringify(
              Object.fromEntries(
                Object.getOwnPropertyNames(error).map((key) => [
                  key,
                  (error as unknown as Record<string, unknown>)[key],
                ]),
              ),
              null,
              2,
            );
          }
          return String(error);
        };

        // Engine has cleared us via `read` (foreign-named applications are
        // surfaced as `Unowned`). Re-fetch the existing application to fold
        // it into the upsert path.
        const existingByName = yield* findApplicationByName(name);

        if (existingByName) {
          yield* Effect.logInfo(
            `Cloudflare Container create: adopting existing application ${name}`,
          );
          return yield* upsertApplication({
            id,
            news,
            existing: toAttributes(existingByName),
            durableObjects,
            session,
          });
        }

        yield* Effect.logInfo(
          `Cloudflare Container create: creating application ${name}`,
        );
        yield* session.note(`Creating container application ${name}...`);
        const adoptExistingByName = Effect.gen(function* () {
          yield* Effect.logInfo(
            `Cloudflare Container create: application ${name} already exists, adopting`,
          );
          const existing = yield* findApplicationByName(name);
          if (!existing) {
            return yield* Effect.fail(
              new Error(
                `Container application "${name}" already exists but could not be found for adoption.`,
              ),
            );
          }
          return yield* upsertApplication({
            id,
            news,
            existing: toAttributes(existing),
            durableObjects,
            session,
          });
        });

        const application = yield* Containers.createContainerApplication({
          accountId,
          name,
          ...scalingDefaults(news),
          affinities: news.affinities,
          configuration,
          durableObjects,
        }).pipe(
          Effect.catchTag("DurableObjectAlreadyHasApplication", () =>
            durableObjects
              ? Effect.gen(function* () {
                  const existing = yield* findApplicationByNamespace(
                    durableObjects.namespaceId,
                  );
                  const recovery = resolveDurableObjectApplicationRecovery({
                    namespaceId: durableObjects.namespaceId,
                    expectedName: name,
                    existingName: existing?.name,
                  });
                  if (!recovery.canAdopt) {
                    return yield* Effect.fail(new Error(recovery.message));
                  }
                  if (!existing) {
                    return yield* Effect.fail(
                      new Error(
                        `Container application for Durable Object namespace "${durableObjects.namespaceId}" already exists but could not be found for adoption.`,
                      ),
                    );
                  }
                  return yield* upsertApplication({
                    id,
                    news,
                    existing: toAttributes(existing),
                    durableObjects,
                    session,
                  });
                })
              : Effect.fail(
                  new Error(
                    "Durable Object namespace already has a container application. Set AdoptPolicy to adopt it.",
                  ),
                ),
          ),
          Effect.catchIf(
            (e) =>
              "message" in (e as any) &&
              String((e as any).message).includes("already exists"),
            () => adoptExistingByName,
          ),
          Effect.tapError((error) =>
            Effect.logError(
              `Cloudflare Container create error: ${describeError(error)}`,
            ),
          ),
        );

        return "applicationId" in application
          ? application
          : toAttributes(application);
      });

      const upsertApplication = Effect.fn(function* ({
        id,
        news,
        existing,
        durableObjects,
        session,
      }: {
        id: string;
        news: AnyContainerApplicationProps;
        existing: ContainerApplication["Attributes"];
        // The DO attachment to (re)create with if the "existing" application
        // turns out to be gone. Threaded through so the update→create fallback
        // below preserves the binding.
        durableObjects: { namespaceId: string } | undefined;
        session: { note: (message: string) => Effect.Effect<void> };
      }) {
        const { accountId } = yield* yield* CloudflareEnvironment;

        yield* Effect.logInfo(
          `Cloudflare Container update: preparing ${existing.applicationName}`,
        );
        const env = makeContainerEnv(news, accountId);
        const { build, imageRef, imageHash, dev } = yield* computeImage(
          id,
          news,
          env,
        );
        const configuration = desiredConfiguration(news, env, imageRef);

        if (imageHash !== existing.hash?.image) {
          yield* buildAndPushImage(id, news, build, imageRef, session);
        }

        yield* session.note(
          `Updating container application ${existing.applicationName}...`,
        );
        const application = yield* retryForContainerApplicationReadiness(
          "update",
          existing.applicationId,
          Containers.updateContainerApplication({
            accountId,
            applicationId: existing.applicationId,
            ...scalingDefaults(news),
            affinities: news.affinities,
            configuration,
          }),
        ).pipe(
          // The "existing" application was observed from an eventually-
          // consistent list/get but is actually gone — e.g. a stale row that
          // lingered after a replacement/DO-recreate delete, surfaced by
          // either the by-name or by-namespace lookup. Updating a ghost
          // exhausts the readiness window and then fails permanently with
          // `ContainerApplicationNotFound`. Instead, create it fresh so
          // reconcile converges regardless of the stale observation. By the
          // time the bounded readiness retry has elapsed, the deleted row has
          // fallen out of the eventually-consistent views, so this create
          // does not re-collide.
          Effect.catchTag("ContainerApplicationNotFound", () =>
            Effect.gen(function* () {
              yield* Effect.logInfo(
                `Cloudflare Container update: ${existing.applicationName} no longer exists, creating fresh`,
              );
              return yield* Containers.createContainerApplication({
                accountId,
                name: existing.applicationName,
                ...scalingDefaults(news),
                affinities: news.affinities,
                configuration,
                durableObjects,
              });
            }),
          ),
        );
        const updated = toAttributes(application);
        if (!deepEqual(existing.configuration, configuration)) {
          yield* Effect.logInfo(
            `Cloudflare Container update: creating rollout for ${updated.applicationName}`,
          );
          yield* maybeCreateRollout({
            applicationId: updated.applicationId,
            configuration,
            rollout: news.rollout,
          });
        }
        return { ...updated, configuration, hash: { image: imageHash }, dev };
      });

      const getDurableObjects = (
        bindings: ResourceBinding<ContainerApplication["Binding"]>[],
      ) => {
        const dos = bindings.flatMap((b) =>
          b.data.durableObjects ? [b.data.durableObjects] : [],
        );
        // A single DO namespace may appear in multiple bindings (e.g. when
        // a Container is referenced by several resources). Dedupe by namespaceId.
        const uniqueDos = dos.filter(
          (d, i, arr) =>
            arr.findIndex((other) => other.namespaceId === d.namespaceId) === i,
        );
        if (uniqueDos.length === 0) {
          return Effect.succeed(undefined);
        }
        if (uniqueDos.length === 1) {
          return Effect.succeed(uniqueDos[0]);
        }
        return Effect.die(
          new Error(
            `A Container can only be bound to one Durable Object namespace. Found ${uniqueDos.length} unique namespaces in bindings: ${uniqueDos.map((d) => d.namespaceId).join(", ")}`,
          ),
        );
      };

      return ContainerPlatform.Provider.of({
        stables: ["accountId", "applicationId"],
        diff: Effect.fn(function* ({
          id,
          olds = {},
          news = {},
          output,
          newBindings,
          oldBindings,
        }) {
          if (!isResolved(news) || !isResolved(newBindings)) {
            return undefined;
          }
          const { accountId } = yield* yield* CloudflareEnvironment;

          const oldName =
            output?.applicationName ??
            (yield* createApplicationName(id, olds.name));
          // Auto-generated names are engine-owned: the deployed name stays
          // authoritative even if the generator would name this id differently
          // today. Only an explicit user-provided name can force a replace.
          const name = news.name ?? oldName;

          if (
            (output?.accountId ?? accountId) !== accountId ||
            name !== oldName
          ) {
            return { action: "replace" } as const;
          }

          const hasDurableObjects =
            (yield* getDurableObjects(newBindings)) !== undefined;
          const hadDurableObjects =
            (yield* getDurableObjects(oldBindings)) !== undefined;
          if (hasDurableObjects !== hadDurableObjects) {
            return { action: "replace" } as const;
          }

          if (!output) {
            return undefined;
          }

          // A `dev:` applicationId means the resource only exists locally and
          // the real application has never been created. Promote it by forcing
          // an update so reconcile creates the live application.
          if (!isLiveId(output.applicationId)) {
            // Override stables to only include the accountId because the applicationId is going to change.
            return { action: "update", stables: ["accountId"] } as const;
          }

          const { imageHash, dev } = yield* computeImage(
            id,
            news,
            makeContainerEnv(news, accountId),
          );
          if (imageHash !== output.hash?.image || !deepEqual(dev, output.dev)) {
            return { action: "update" } as const;
          }
        }),
        precreate: Effect.fn(function* ({ id, news = {}, session }) {
          const name = yield* createApplicationName(id, news.name);
          yield* Effect.logInfo(
            `Cloudflare Container precreate: starting ${name}`,
          );

          const { accountId } = yield* yield* CloudflareEnvironment;
          const env = makeContainerEnv(news, accountId);
          const { build, imageRef, imageHash, dev } = yield* computeImage(
            id,
            news,
            env,
          );
          const configuration = desiredConfiguration(news, env, imageRef);
          yield* buildAndPushImage(id, news, build, imageRef, session);

          // Precreate intentionally omits the Durable Object attachment so the
          // worker can bind to this application id and break the circular
          // dependency. The final create step recreates the application with the
          // resolved namespace when needed.
          const result = yield* createApplication({
            id,
            news,
            name,
            configuration,
            durableObjects: undefined,
            session: {
              ...session,
              note: (message) =>
                session.note(message.replace("Creating", "Pre-creating")),
            },
          });
          return {
            ...("applicationId" in result ? result : toAttributes(result)),
            hash: { image: imageHash },
            dev,
          };
        }),
        reconcile: Effect.fn(function* ({
          id,
          news = {},
          bindings,
          output,
          session,
        }) {
          // Prefer the deployed name: regenerating would target a different
          // resource if the generator's output for this id ever drifts.
          const name =
            output?.applicationName ??
            (yield* createApplicationName(id, news.name));
          yield* Effect.logInfo(
            `Cloudflare Container reconcile: starting ${name}`,
          );
          const durableObjects = yield* getDurableObjects(bindings);
          const { accountId } = yield* yield* CloudflareEnvironment;
          const env = makeContainerEnv(news, accountId);
          const { build, imageRef, imageHash, dev } = yield* computeImage(
            id,
            news,
            env,
          );
          const configuration = desiredConfiguration(news, env, imageRef);

          // Observe — re-fetch the cached application to confirm it still
          // exists. Cloudflare reports a deleted container application as
          // `ContainerApplicationNotFound`; we fall back to a name lookup
          // so we can recover from out-of-band deletes or partial state
          // persistence failures.
          let existing: ContainerApplication["Attributes"] | undefined;
          // A `dev:` applicationId never exists on Cloudflare — skip the
          // cached-id fetch and fall through to the name lookup / create path
          // so we promote the local resource to a real application.
          if (output?.applicationId && isLiveId(output.applicationId)) {
            existing = yield* Containers.getContainerApplication({
              accountId: output.accountId,
              applicationId: output.applicationId,
            }).pipe(
              Effect.map((app) => ({
                ...toAttributes(app),
                hash: output.hash,
              })),
              Effect.catchTag("ContainerApplicationNotFound", () =>
                Effect.succeed(undefined),
              ),
            );
          }
          if (!existing) {
            const found = yield* findApplicationByName(name);
            if (found) {
              existing = {
                ...toAttributes(found),
                hash: output?.hash,
              };
            }
          }

          // Special case: precreate produced an application without the
          // durable object attachment, but the real reconcile now has one
          // (or vice versa). The DO attachment is immutable, so we delete
          // and recreate. Adoption-by-namespace is preferred when an app
          // already owns the namespace.
          if (existing && !deepEqual(existing.durableObjects, durableObjects)) {
            if (durableObjects) {
              const owner = yield* findApplicationByNamespace(
                durableObjects.namespaceId,
              );
              const recovery = resolveDurableObjectApplicationRecovery({
                namespaceId: durableObjects.namespaceId,
                expectedName: name,
                existingName: owner?.name,
              });
              if (recovery.canAdopt) {
                if (!owner) {
                  return yield* Effect.fail(
                    new Error(
                      `Container application for Durable Object namespace "${durableObjects.namespaceId}" already exists but could not be found for adoption.`,
                    ),
                  );
                }
                return yield* upsertApplication({
                  id,
                  news,
                  existing: toAttributes(owner),
                  durableObjects,
                  session,
                });
              }
            }
            yield* Effect.logInfo(
              `Cloudflare Container reconcile: recreating ${name} to attach durable object binding`,
            );
            yield* session.note(
              `Recreating container application ${name} with durable object binding...`,
            );
            yield* Containers.deleteContainerApplication({
              accountId: existing.accountId,
              applicationId: existing.applicationId,
            }).pipe(
              Effect.catchTag(
                "ContainerApplicationNotFound",
                () => Effect.void,
              ),
            );
            // Wait out the eventually-consistent `list` so the recreate below
            // doesn't re-adopt the just-deleted application and then try to
            // update a now-gone id (see `waitForApplicationDeleted`).
            yield* waitForApplicationDeleted(name, existing.applicationId);
            if (imageHash !== existing.hash?.image) {
              yield* buildAndPushImage(id, news, build, imageRef, session);
            }
            const result = yield* createApplication({
              id,
              news,
              name,
              configuration,
              durableObjects,
              session,
            });
            return {
              ...("applicationId" in result ? result : toAttributes(result)),
              hash: { image: imageHash },
              dev,
            };
          }

          // Sync — application exists with correct DO attachment. Apply
          // the desired configuration (image + scheduling + secrets, etc.)
          // through the upsert path, which builds and pushes the image
          // only when the hash changed and creates a rollout if the
          // configuration drifted.
          if (existing) {
            return yield* upsertApplication({
              id,
              news,
              existing,
              durableObjects,
              session,
            });
          }

          // Ensure — no application exists. Build and push the image,
          // then create. `createApplication` itself tolerates concurrent
          // creates by adopting an existing application with the same
          // name or namespace.
          yield* buildAndPushImage(id, news, build, imageRef, session);
          const result = yield* createApplication({
            id,
            news,
            name,
            configuration,
            durableObjects,
            session,
          });
          return {
            ...("applicationId" in result ? result : toAttributes(result)),
            hash: { image: imageHash },
            dev,
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          // A `dev:` applicationId only exists locally — there is no live
          // application to delete on Cloudflare.
          if (!isLiveId(output.applicationId)) return;
          yield* Effect.logInfo(
            `Cloudflare Container delete: deleting ${output.applicationName}`,
          );
          yield* Containers.deleteContainerApplication({
            accountId: output.accountId,
            applicationId: output.applicationId,
          }).pipe(
            Effect.catchTag("ContainerApplicationNotFound", () => Effect.void),
          );
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const readByName = (name: string) =>
            Effect.gen(function* () {
              yield* Effect.logInfo(
                `Cloudflare Container read: looking up ${name}`,
              );
              const existing = yield* findApplicationByName(name);
              if (!existing) {
                yield* Effect.logInfo(
                  `Cloudflare Container read: ${name} not found`,
                );
                return undefined;
              }
              return {
                ...toAttributes(existing),
                hash: output?.hash,
                // The dev image is a local build-context reference that the
                // API can't return — preserve the persisted one so a refresh
                // doesn't wipe it (which would break a later `alchemy dev`).
                dev: output?.dev,
              };
            });

          let attrs: ContainerApplication["Attributes"] | undefined;
          // A `dev:` applicationId never exists on Cloudflare — look the
          // application up by its (deterministic) name instead of hitting the
          // API with a fake id.
          if (output?.applicationId && !isLiveId(output.applicationId)) {
            return yield* readByName(output.applicationName);
          }
          if (output?.applicationId) {
            yield* Effect.logInfo(
              `Cloudflare Container read: checking ${output.applicationName}`,
            );
            attrs = yield* Containers.getContainerApplication({
              accountId: output.accountId,
              applicationId: output.applicationId,
            }).pipe(
              Effect.map((app) => ({
                ...toAttributes(app),
                hash: output.hash,
                dev: output.dev,
              })),
              Effect.catchTag("ContainerApplicationNotFound", () =>
                readByName(output.applicationName),
              ),
            );
            // If we matched by id from prior state, treat as owned.
            return attrs;
          }

          const name = yield* createApplicationName(id, olds?.name);
          attrs = yield* readByName(name);
          if (!attrs) return undefined;
          // Cloudflare container applications carry no ownership signal that
          // we can read back from the API, so a name match is not proof of
          // ownership. Brand it `Unowned` so the engine surfaces
          // `OwnedBySomeoneElse` unless the caller opted in via `--adopt`.
          return Unowned(attrs);
        }),
        list: () =>
          Effect.gen(function* () {
            const { accountId } = yield* yield* CloudflareEnvironment;
            // Account-scoped collection. `listContainerApplications` returns
            // the full application objects in one (non-paginated) response, so
            // each item already carries the complete `read` attributes shape —
            // no per-item hydration is required.
            return yield* Containers.listContainerApplications({
              accountId,
            }).pipe(
              Effect.map((apps) => apps.map((app) => toAttributes(app))),
              // Accounts without the containers product reject the route; treat
              // a non-entitled account as an empty collection rather than an
              // error.
              Effect.catchTag("InvalidRoute", () => Effect.succeed([])),
            );
          }),
        tail: ({ output }) =>
          telemetry.tailStream({
            accountId: output.accountId,
            filters: containerFilters(output.applicationId),
          }),
        logs: ({ output, options }) =>
          telemetry.queryLogs({
            accountId: output.accountId,
            filters: containerFilters(output.applicationId),
            options,
          }),
      });
    }),
  );

const containerFilters = (applicationId: string): TelemetryFilter[] => [
  {
    key: "$metadata.type",
    operation: "eq",
    type: "string",
    value: "cf-container",
  },
  {
    key: "$metadata.service",
    operation: "eq",
    type: "string",
    value: applicationId,
  },
];

const resolveDurableObjectApplicationRecovery = ({
  namespaceId,
  expectedName,
  existingName,
}: {
  namespaceId: string;
  expectedName: string;
  existingName: string | undefined;
}) => {
  if (!existingName) {
    return {
      canAdopt: false as const,
      message: `Container application for Durable Object namespace "${namespaceId}" already exists but could not be found for adoption.`,
    };
  }
  if (existingName !== expectedName) {
    return {
      canAdopt: false as const,
      message: `Existing container application "${existingName}" is already attached to Durable Object namespace "${namespaceId}". Use that application name to adopt it.`,
    };
  }
  return {
    canAdopt: true as const,
  };
};

// Cap each delay at 3s so the readiness window is ~30s over 10 attempts; an
// uncapped `Schedule.exponential(150)` reaches a ~76s single delay by the 10th
// retry (~150s total), which both blows test budgets and needlessly stalls the
// update→create fallback when the target is genuinely gone.
const containerApplicationReadinessSchedule = Schedule.max([
  Schedule.min([Schedule.exponential(150), Schedule.spaced("3 seconds")]),
  Schedule.recurs(10),
]);

const isContainerApplicationNotFound = (
  error: unknown,
): error is Containers.ContainerApplicationNotFound =>
  typeof error === "object" &&
  error !== null &&
  "_tag" in error &&
  error._tag === "ContainerApplicationNotFound";

export const retryForContainerApplicationReadiness = <A, E, R>(
  operation: string,
  applicationId: string,
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.tapError((error) =>
      isContainerApplicationNotFound(error)
        ? Effect.logDebug(
            `Cloudflare Container ${operation}: application ${applicationId} not found yet, retrying`,
          )
        : Effect.void,
    ),
    Effect.retry({
      while: isContainerApplicationNotFound,
      schedule: containerApplicationReadinessSchedule,
    }),
  );

const toAttributes = (
  application:
    | Containers.CreateContainerApplicationResponse
    | Containers.UpdateContainerApplicationResponse
    | Containers.GetContainerApplicationResponse
    | Containers.ListContainerApplicationsResponse[number],
): ContainerApplication["Attributes"] => ({
  applicationId: application.id,
  applicationName: application.name,
  accountId: application.accountId,
  schedulingPolicy: application.schedulingPolicy,
  instances: application.instances,
  maxInstances: application.maxInstances,
  constraints: normalizeNulls(
    application.constraints as ContainerApplication.Constraints | undefined,
  ),
  affinities: normalizeNulls(
    application.affinities as ContainerApplication.Affinities | undefined,
  ),
  configuration: normalizeNulls(
    application.configuration as ContainerApplication.Configuration,
  ),
  durableObjects: normalizeNulls(application.durableObjects) as
    | { namespaceId: string }
    | undefined,
  createdAt: application.createdAt,
  version: application.version,
  dev: undefined,
});
