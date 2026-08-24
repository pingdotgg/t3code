import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Artifacts from "../../Artifacts.ts";
import { hashDirectory } from "../../Command/Memo.ts";
import { isResolved } from "../../Diff.ts";
import * as RpcProvider from "../../Local/RpcProvider.ts";
import { sha256Object } from "../../Util/sha256.ts";
import { normalizeNulls } from "../../Util/stable.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import { generateLocalId, LOCAL_ENTRY_URL } from "../LocalRuntime.ts";
import type {
  AnyContainerApplicationProps,
  ContainerApplication,
  DevContainerImage,
} from "./ContainerApplication.ts";
import { isInlineDockerfile } from "../../Docker/Dockerfile.ts";
import {
  createContainerApplicationName,
  makeContainerEnv,
  materializeInlineDockerfileContext,
  prepareContainerBuildContext,
  validateContainerImageProps,
} from "./ContainerBundle.ts";
import { ContainerPlatform } from "./ContainerPlatform.ts";

/**
 * Local (dev) provider for Cloudflare Container applications.
 *
 * The Docker build/run is owned by `@distilled.cloud/cloudflare-runtime`; this
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
    LOCAL_ENTRY_URL,
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
          yield* validateContainerImageProps(news);
          // Variant 1 — Effect-native program. Bundle `main` and write it
          // (plus the generated Dockerfile) into a stable build context
          // directory. `Docker.build` in cloudflare-runtime reads `dockerfile`
          // as a file path and uses `context` as the build context, so we
          // point `dev` at both. The build-context materialization is shared
          // with the live provider (see `prepareContainerBuildContext`).
          if (news.main) {
            const { context, dockerfile, hash } =
              yield* prepareContainerBuildContext(id, news);
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
          if (
            news.dockerfile !== undefined &&
            isInlineDockerfile(news.dockerfile)
          ) {
            const content = news.dockerfile.content;
            if (typeof content !== "string") {
              return yield* Effect.die(
                new Error(
                  "Inline `dockerfile` content is an unresolved Output at image-build time — its dependencies have not resolved yet. Break the cycle or inline the resolved value.",
                ),
              );
            }
            const { context } = yield* materializeInlineDockerfileContext(
              id,
              content,
            );
            return {
              dev: {
                context: path.relative(process.cwd(), context),
                dockerfile: "Dockerfile",
              } as DevContainerImage,
              hash: yield* sha256Object({ dockerfile: content }),
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
            } as DevContainerImage,
            hash: yield* sha256Object({
              contextHash,
              dockerfile: dockerfileContent,
            }),
          };
        }).pipe(Artifacts.cached(`container-image:${id}`));

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
        output,
      }: {
        id: string;
        news: AnyContainerApplicationProps;
        output: ContainerApplication["Attributes"] | undefined;
      }) {
        const { accountId } = yield* yield* CloudflareEnvironment;
        const env = makeContainerEnv(news, accountId);
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
          dev: { ...dev, env },
          hash: { image: hash },
        } satisfies ContainerApplication["Attributes"];
      });

      return {
        // No HMR for containers (yet): bundle once on first reconcile, then
        // treat the resource as a no-op so subsequent reconciles don't
        // re-bundle on every change.
        stables: ["accountId", "applicationId"],
        diff: Effect.fn(function* ({ id, news, output }) {
          if (!output) return { action: "update" };
          if (!isResolved(news)) return undefined;
          const input = yield* prepareImage(id, news);
          return input.hash !== output.hash?.image || !output.dev
            ? { action: "update" }
            : undefined;
        }),
        read: Effect.fn(function* ({ output }) {
          return output;
        }),
        // Precreate breaks the worker <-> container cycle: the worker depends
        // on the container's `dev` image, while the container binds the
        // worker-hosted Durable Object namespace. Building the image here lets
        // the worker resolve `dev` without waiting on the container's reconcile.
        precreate: Effect.fn(function* ({ id, news }) {
          return yield* makeAttributes({ id, news, output: undefined });
        }),
        reconcile: Effect.fn(function* ({ id, news, output }) {
          return yield* makeAttributes({ id, news, output });
        }),
        delete: Effect.fn(function* () {
          // Nothing to tear down: the build context lives under `.alchemy/tmp`
          // and is reused across runs; the running container is owned by the
          // worker runtime.
        }),
      };
    }),
  );
