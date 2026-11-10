import { isInlineDockerfile } from "@alchemy.run/docker/Dockerfile";
import * as Artifacts from "alchemy/Artifacts";
import { hashDirectory } from "alchemy/Command/Memo";
import { isResolved } from "alchemy/Diff";
import * as RpcProvider from "alchemy/Local/RpcProvider";
import type { ResourceBinding } from "alchemy/Resource";
import { sha256Object } from "alchemy/Util/sha256";
import { normalizeNulls } from "alchemy/Util/stable";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import { localAccountId } from "../LocalAccount.ts";
import { generateLocalId, LOCAL_PROVIDERS_URL } from "../LocalRuntime.ts";
import type {
  AnyContainerApplicationProps,
  ContainerApplication,
  DevContainerImage,
} from "./ContainerApplication.ts";
import {
  createContainerApplicationName,
  makeContainerEnv,
  materializeInlineDockerfileContext,
  prepareContainerBuildContext,
  validateContainerImageProps,
} from "./ContainerBundle.ts";
import {
  durableObjectPlaceholder,
  hasImageSource,
  isDurableObjectContainer,
  validateContainerConfiguration,
} from "./ContainerConfiguration.ts";
import { ContainerPlatform } from "./ContainerPlatform.ts";

/**
 * Local (dev) provider for Cloudflare Container applications.
 *
 * The Docker build/run is owned by `@alchemy.run/cloudflare-runtime/core`; this
 * provider's only job is to resolve the `dev` image the runtime should use —
 * a build context to `docker build` (Effect-native `main` or a user-supplied
 * Dockerfile) or a remote image to `docker pull` — mirroring the three image
 * variants of the live provider's `computeImage`.
 *
 * Everything else on the attributes is a placeholder: the real
 * `applicationId`/`configuration`/etc. only exist once the live provider
 * promotes this resource on a real deploy. The `applicationId` uses the local
 * id mechanism (`dev:<uuid>`) so the live provider can detect a dev resource
 * and create the real one.
 */
export const LocalContainerProvider = () =>
  RpcProvider.effect(
    ContainerPlatform,
    LOCAL_PROVIDERS_URL,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      // Resolve the `dev` image plus a content hash for change detection.
      // Cached per run (`Artifacts.cached`, keyed by resource id) so repeated
      // diffs/reconciles in a single dev session don't re-bundle or re-hash.
      //
      // IMPORTANT: the cached result must stay env-free. The cache is warmed
      // by `precreate`, which runs against unresolved props — binding-derived
      // env values (e.g. an ApiToken's value/accountId) are still unresolved
      // `Output`s there and get skipped. Caching env here would freeze that
      // incomplete env and start the container without its bindings;
      // `makeAttributes` attaches the freshly-computed env instead.
      const prepareImage = (id: string, news: AnyContainerApplicationProps) =>
        Effect.gen(function* () {
          yield* validateContainerImageProps(id, news);
          // Variant 1 — Effect-native program. Bundle `main` and write it
          // (plus the generated Dockerfile) into a stable build context
          // directory. `Docker.build` in cloudflare-runtime reads `dockerfile`
          // as a file path and uses `context` as the build context, so we
          // point `dev` at both. The build-context materialization is shared
          // with the live provider (see `prepareContainerBuildContext`).
          if (news.main) {
            const { context, dockerfile, hash } = yield* prepareContainerBuildContext(id, news);
            return {
              dev: {
                context: path.relative(process.cwd(), context),
                dockerfile: path.relative(context, dockerfile),
              } as DevContainerImage,
              hash,
            };
          }

          // Variant 2 — pre-built remote image. The runtime pulls it
          // directly; there is nothing to build.
          if (news.image) {
            return {
              dev: { imageUri: news.image } as DevContainerImage,
              hash: yield* sha256Object({ image: news.image }),
            };
          }

          // Variant 3a — inline Dockerfile content: materialize into the
          // same stable generated context the live provider uses and point
          // the runtime's build at it.
          if (news.dockerfile !== undefined && isInlineDockerfile(news.dockerfile)) {
            const content = news.dockerfile.content;
            if (typeof content !== "string") {
              return yield* Effect.die(
                new Error(
                  "Inline `dockerfile` content is an unresolved Output at image-build time — its dependencies have not resolved yet. Break the cycle or inline the resolved value.",
                ),
              );
            }
            const { context } = yield* materializeInlineDockerfileContext(id, content);
            return {
              dev: {
                context: path.relative(process.cwd(), context),
                dockerfile: "Dockerfile",
                buildArgs: news.build?.args,
              } as DevContainerImage,
              hash: yield* sha256Object({ dockerfile: content, buildArgs: news.build?.args }),
            };
          }

          // Variant 3b — user-supplied Dockerfile path + build context
          // directory. The runtime builds the user's Dockerfile against the
          // (real-path'd) context, exactly like the live provider's
          // `external` variant.
          const context = yield* fs.realPath(news.context ?? ".");
          const dockerfile = news.dockerfile
            ? yield* fs.realPath(news.dockerfile)
            : path.join(context, "Dockerfile");
          const contextHash = yield* hashDirectory({ cwd: context });
          const dockerfileContent = yield* fs.readFileString(dockerfile);
          return {
            dev: {
              context: path.relative(process.cwd(), context),
              dockerfile: path.relative(context, dockerfile),
              buildArgs: news.build?.args,
            } as DevContainerImage,
            hash: yield* sha256Object({
              contextHash,
              dockerfile: dockerfileContent,
              buildArgs: news.build?.args,
            }),
          };
        }).pipe(Artifacts.cached(`container-image:${id}`));

      /**
       * The props that decide what the dev IMAGE is, picked off the
       * possibly-unresolved plan-time props — or `undefined` when any of
       * them has not resolved yet. Everything else (env, instances, …) may
       * still carry Outputs/Effects (the `.make` form's `exports` impl
       * Effect never resolves at all) without disabling the content check.
       */
      const resolvedImageInputs = (input: unknown): AnyContainerApplicationProps | undefined => {
        if (typeof input !== "object" || input === null) return undefined;
        const news = input as AnyContainerApplicationProps;
        const picked = {
          schedulingPolicy: news.schedulingPolicy,
          main: news.main,
          image: news.image,
          dockerfile: news.dockerfile,
          context: news.context,
          runtime: news.runtime,
          handler: news.handler,
          isExternal: news.isExternal,
          external: news.external,
          // Secrets attach later (see `withBuildSecrets`) and stay out of the hash.
          build: news.build === undefined ? undefined : { ...news.build, secrets: undefined },
          autoInstallExternals: news.autoInstallExternals,
        };
        if (!isResolved(picked)) return undefined;
        if (
          picked.schedulingPolicy !== "durable_object" &&
          !picked.main &&
          !picked.image &&
          !picked.dockerfile &&
          !picked.context
        ) {
          return undefined;
        }
        return picked as AnyContainerApplicationProps;
      };

      // Attached outside `prepareImage` for the same reason env is: secrets
      // may be binding Outputs that have not resolved when its cache warms.
      const withBuildSecrets = (
        dev: DevContainerImage,
        news: AnyContainerApplicationProps,
      ): DevContainerImage =>
        "dockerfile" in dev && news.build?.secrets !== undefined
          ? { ...dev, buildSecrets: news.build.secrets }
          : dev;

      const placeholderConfiguration = (
        props: AnyContainerApplicationProps,
        env: Record<string, string | Redacted.Redacted<string>>,
      ) =>
        normalizeNulls({
          image: "local",
          instanceType: props.instanceType,
          observability: props.observability,
          sshPublicKeyIds: props.sshPublicKeyIds,
          secrets: props.secrets,
          vcpu: props.vcpu,
          memory: props.memory,
          memoryMib: props.memoryMib,
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

      const makeAttributes = Effect.fn(function* ({
        id,
        news,
        bindings,
        output,
      }: {
        id: string;
        news: AnyContainerApplicationProps;
        bindings: ResourceBinding<ContainerApplication["Binding"]>[];
        output: ContainerApplication["Attributes"] | undefined;
      }) {
        yield* validateContainerConfiguration(news, output?.schedulingPolicy);
        const accountId = yield* localAccountId;
        if (isDurableObjectContainer(news)) {
          const attributes = durableObjectPlaceholder({
            applicationId: output?.applicationId ?? generateLocalId(),
            applicationName: yield* createContainerApplicationName(id, undefined),
            accountId,
            createdAt: output?.createdAt ?? new Date().toISOString(),
            observability: news.observability,
          });
          if (!hasImageSource(news)) return attributes;
          const { dev, hash } = yield* prepareImage(id, news);
          return {
            ...attributes,
            // workerd resolves each image by its key in the class's image
            // map, so locally the image reference is the Container's id.
            image: id,
            dev: withBuildSecrets(dev, news),
            hash: { image: hash },
          } satisfies ContainerApplication["Attributes"];
        }
        const env = makeContainerEnv(news, accountId, bindings);
        const { dev, hash } = yield* prepareImage(id, news);
        return {
          applicationId: output?.applicationId ?? generateLocalId(),
          applicationName: yield* createContainerApplicationName(id, news.name),
          accountId: output?.accountId ?? accountId,
          schedulingPolicy: news.schedulingPolicy ?? "default",
          instances: news.instances ?? 1,
          maxInstances: news.maxInstances ?? 1,
          constraints: news.constraints,
          affinities: news.affinities,
          configuration: placeholderConfiguration(news, env),
          durableObjects: undefined,
          createdAt: new Date().toISOString(),
          version: 1,
          dev: { ...withBuildSecrets(dev, news), env },
          hash: { image: hash },
        } satisfies ContainerApplication["Attributes"];
      });

      return {
        stables: ["accountId", "applicationId"],
        diff: Effect.fn(function* ({ id, news, output }) {
          if (isResolved(news)) {
            yield* validateContainerConfiguration(news, output?.schedulingPolicy);
          }
          if (!output) return { action: "update" };
          // A content-only edit (an imported module of `main`, a Dockerfile,
          // a context file) changes no prop, so the engine's structural
          // fallback would call it a noop and the image would never rebuild.
          // Compare the recomputed image hash instead — and gate only on
          // the IMAGE inputs being resolved, not the whole props bag: the
          // platform `.make` form carries an `exports` impl Effect that is
          // never "resolved", and requiring full resolution silently
          // disabled this check for every effectful container.
          const imageInputs = resolvedImageInputs(news);
          if (imageInputs !== undefined) {
            if (isDurableObjectContainer(imageInputs) && !hasImageSource(imageInputs)) {
              return output.image !== undefined ? { action: "update" } : undefined;
            }
            // Recompute fresh on every plan. `prepareImage` is memoized so
            // a plan's diff→precreate→reconcile chain bundles once — but
            // this provider runs in the RPC sidecar, whose `ArtifactStore`
            // outlives every run, so without this eviction the FIRST run's
            // hash would be compared forever.
            yield* (yield* Artifacts.Artifacts).delete(`container-image:${id}`);
            const input = yield* prepareImage(id, imageInputs);
            if (input.hash !== output.hash?.image || !output.dev) {
              return { action: "update" };
            }
          }
          if (!isResolved(news)) return undefined;
          return !output.dev ? { action: "update" } : undefined;
        }),
        read: Effect.fn(function* ({ output }) {
          return output;
        }),
        // Precreate breaks the worker <-> container cycle: the worker depends
        // on the container's `dev` image, while the container binds the
        // worker-hosted Durable Object namespace. Building the image here lets
        // the worker resolve `dev` without waiting on the container's reconcile.
        precreate: Effect.fn(function* ({ id, news }) {
          // Bindings are not resolved yet at precreate (that is what breaks
          // the cycle); binding-injected env lands on the reconcile below.
          return yield* makeAttributes({
            id,
            news,
            bindings: [],
            output: undefined,
          });
        }),
        reconcile: Effect.fn(function* ({ id, news, bindings, output }) {
          return yield* makeAttributes({ id, news, bindings, output });
        }),
        delete: Effect.fn(function* () {
          // Nothing to tear down: the build context lives under `.alchemy/tmp`
          // and is reused across runs; the running container is owned by the
          // worker runtime.
        }),
      };
    }),
  );
