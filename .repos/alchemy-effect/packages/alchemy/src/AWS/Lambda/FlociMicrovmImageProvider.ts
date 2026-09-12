/** @effect-diagnostics anyUnknownInErrorContext:off */

/**
 * The `alchemy dev` provider for `AWS.Lambda.MicrovmImage`: builds the image
 * as a plain LOCAL `docker build` and hands the emulator a pre-built
 * reference, so an image reload costs what a `docker build` costs — with
 * real BuildKit layer caching against the user's actual sources.
 *
 * The live flow (zip the context → upload to S3 → floci downloads, extracts
 * to a fresh temp dir, and docker-builds server-side) is faithful to the
 * real AWS API but hostile to dev: the fresh extract defeated layer caching
 * and every content edit cost a full image build (~60s measured). Here the
 * flow is:
 *
 *  1. bundle (`main`) or use the user's context/Dockerfile as-is;
 *  2. `docker build -t alchemy-dev/microvm-<name>:<contentHash>` on the
 *     HOST daemon — unchanged layers cache, so a well-ordered Dockerfile
 *     only rebuilds its tail (the alchemy-generated Dockerfile installs the
 *     runtime BEFORE copying the bundle for exactly this reason);
 *  3. delegate to the LIVE reconcile with
 *     `codeArtifact: { uri: "docker://<tag>" }` — the alchemy floci fork
 *     (≥ the docker-artifact build) short-circuits its build for that form
 *     and marks the version ACTIVE immediately.
 *
 * `RunMicrovm` defaults to the latest ACTIVE version, so every VM booted
 * after a rebuild runs the new image; running VMs are deliberately NOT
 * terminated — MicroVM sessions are stateful, and killing a user's live
 * shell/sandbox on every source edit would be worse than serving the old
 * code until it re-runs.
 *
 * Built on the shared dev-watch skeleton
 * ([DevWatchProvider](../Local/DevWatchProvider.ts)); the watch trigger is
 * the shared [ImageSourceTrigger](../Local/ImageSourceTrigger.ts) (`main` →
 * rolldown module-graph watch, `context` → fs-watch incl. an
 * outside-context Dockerfile).
 */

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Artifacts from "../../Artifacts.ts";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { AlchemyContext } from "../../AlchemyContext.ts";
import { getStableContextDir } from "../../Bundle/TempRoot.ts";
import { Docker, DockerLive } from "../../Docker/Docker.ts";
import { isInlineDockerfile } from "../../Docker/Dockerfile.ts";
import { hashDirectory } from "../../Command/Memo.ts";
import { sha256 } from "../../Util/sha256.ts";
import {
  flociSidecarEntry,
  makeDevWatchProvider,
} from "../Local/DevWatchProvider.ts";
import { imageSourceTrigger } from "../Local/ImageSourceTrigger.ts";
import type { ImageSourceLike } from "../ECR/ImageSource.ts";
import {
  buildMicrovmDockerfile,
  bundleMicrovmProgram,
  DEFAULT_MICROVM_PORT,
  MICROVM_BASE_DOCKER_IMAGE,
} from "./MicrovmBundle.ts";
import { MicrovmImage, type MicrovmImageProps } from "./MicrovmImage.ts";
import { MicrovmImageProvider } from "./MicrovmProvider.ts";

/**
 * The AWS-managed MicroVM base is not publicly pullable; the floci fork
 * rewrites `FROM public.ecr.aws/lambda/microvms:*` to this Amazon Linux
 * 2023 mirror in its own builds, and host-side dev builds must match so
 * both paths produce the same image.
 */
const LOCAL_MICROVM_BASE_IMAGE =
  process.env.FLOCI_MICROVM_BASE_IMAGE ||
  "public.ecr.aws/amazonlinux/amazonlinux:2023";

const rewriteBaseImage = (dockerfile: string): string =>
  dockerfile
    .split("\n")
    .map((line) => {
      const trimmed = line.trimStart();
      if (!/^from\s/i.test(trimmed)) return line;
      const rest = trimmed.slice(5).trimStart();
      if (!rest.startsWith(MICROVM_BASE_DOCKER_IMAGE.split(":")[0])) {
        return line;
      }
      const space = rest.indexOf(" ");
      const suffix = space >= 0 ? rest.slice(space) : "";
      return `FROM ${LOCAL_MICROVM_BASE_IMAGE}${suffix}`;
    })
    .join("\n");

/**
 * Build the image on the host daemon and return the content-addressed
 * `docker://` artifact reference for it. The tag embeds the content hash,
 * so an unchanged build is a pure cache hit AND the live reconcile's
 * artifact-hash comparison (`sha256(uri:propsId)`) sees content changes.
 */
const buildLocalImage = Effect.fn(function* (
  id: string,
  news: MicrovmImageProps,
) {
  const docker = yield* Docker;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { dotAlchemy } = yield* AlchemyContext;
  const runtime = news.runtime ?? "node";
  const port = news.port ?? DEFAULT_MICROVM_PORT;

  if (news.main) {
    const { files, hash: bundleHash } = yield* bundleMicrovmProgram({
      main: news.main,
      runtime,
      isExternal: news.isExternal ?? false,
      external: news.external,
      port,
      build: news.build,
    });
    const userDockerfile =
      news.dockerfile !== undefined && isInlineDockerfile(news.dockerfile)
        ? (news.dockerfile.content as string)
        : news.dockerfile;
    const dockerfile = rewriteBaseImage(
      buildMicrovmDockerfile(userDockerfile, runtime, port),
    );
    const contentHash = yield* sha256(`${bundleHash}:${dockerfile}`);
    const context = yield* getStableContextDir(
      process.cwd(),
      dotAlchemy,
      `${id}-microvm`,
    );
    yield* docker.materialize({
      context,
      dockerfile,
      files: files.map((f) => ({ path: f.path, content: f.content })),
    });
    const tag = `alchemy-dev/microvm-${id.toLowerCase()}:${contentHash.slice(0, 16)}`;
    yield* docker.image.build({ context, tag });
    return tag;
  }

  if (news.context) {
    const context = yield* fs.realPath(news.context);
    const dockerfilePath =
      news.dockerfile !== undefined && !isInlineDockerfile(news.dockerfile)
        ? yield* fs.realPath(news.dockerfile)
        : path.join(context, "Dockerfile");
    const original = yield* fs.readFileString(dockerfilePath);
    const rewritten = rewriteBaseImage(original);
    const contextHash = yield* hashDirectory({ cwd: context });
    const contentHash = yield* sha256(`${contextHash}:${rewritten}`);
    // The rewritten Dockerfile lives OUTSIDE the user's context (never
    // touch their files); `docker build -f` accepts that.
    const staging = yield* getStableContextDir(
      process.cwd(),
      dotAlchemy,
      `${id}-microvm`,
    );
    const rewrittenPath = path.join(staging, "Dockerfile");
    yield* fs.writeFileString(rewrittenPath, rewritten);
    const tag = `alchemy-dev/microvm-${id.toLowerCase()}:${contentHash.slice(0, 16)}`;
    yield* docker.image.build({ context, file: rewrittenPath, tag });
    return tag;
  }

  return undefined;
});

export const FlociMicrovmImageProvider = () =>
  makeDevWatchProvider<
    MicrovmImage,
    MicrovmImageProps,
    MicrovmImage["Attributes"]
  >(MicrovmImage, flociSidecarEntry(), {
    liveProvider: () => MicrovmImageProvider(),
    services: DockerLive,
    // The restart surface of the watch loop: everything that changes WHAT
    // is built (props flow through the reconcile anyway).
    watchConfigOf: (news, attrs) => {
      const source = news as ImageSourceLike;
      return {
        name: attrs.name,
        main: source.main,
        context: source.context,
        dockerfile: source.dockerfile,
        codeArtifactUri: news.codeArtifact?.uri,
        runtime: news.runtime,
        port: news.port,
        isExternal: news.isExternal,
        external: news.external,
        build: news.build,
      };
    },
    // Mirrors the live diff: the image name is the identity.
    replaceOn: ({ id: _id, olds, news }) =>
      Effect.sync(() =>
        (olds.name ?? null) !== (news.name ?? null)
          ? { action: "replace" as const }
          : undefined,
      ),
    // Build locally, delegate with a pre-built reference. A user-supplied
    // `codeArtifact.uri` passes through untouched (already pre-built).
    transformReconcileNews: ({ id, news }) =>
      Effect.gen(function* () {
        const tag = yield* buildLocalImage(id, news);
        if (tag === undefined) return news;
        // The live reconcile memoizes its resolved artifact per id for the
        // run (`Artifacts.cached`) — but the sidecar's artifact store lives
        // for the whole dev session, so a rebuilt docker:// reference would
        // read back the FIRST reconcile's artifact and no-op forever. Evict
        // so the reconcile resolves the fresh reference.
        yield* (yield* Artifacts.Artifacts).delete(
          `microvm-image-content:${id}`,
        );
        return {
          ...news,
          main: undefined,
          context: undefined,
          dockerfile: undefined,
          codeArtifact: { uri: `docker://${tag}` },
        } satisfies MicrovmImageProps;
      }),
    startWatch: (ctx) =>
      Effect.gen(function* () {
        const trigger = yield* imageSourceTrigger({
          id: ctx.id,
          source: ctx.news as ImageSourceLike,
          isExternal: ctx.news.isExternal,
        });
        yield* trigger.pipe(
          // The re-run builds (cached) and re-reconciles; floci marks the
          // new version ACTIVE immediately, and the next RunMicrovm boots
          // it. Running VMs keep their session (deliberately not killed).
          Stream.runForEach(() =>
            Effect.gen(function* () {
              const startedAt = Date.now();
              yield* Effect.logInfo(
                `[alchemy dev] ${ctx.id}: microvm source changed — rebuilding`,
              );
              const previous = yield* ctx.currentAttrs;
              const attrs = yield* ctx.rerunReconcile;
              if (attrs.codeArtifact?.hash !== previous.codeArtifact?.hash) {
                yield* Effect.logInfo(
                  `[alchemy dev] ${attrs.name}: microvm image rebuilt (v${attrs.latestActiveImageVersion}) in ${Date.now() - startedAt}ms`,
                );
              }
            }).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning(
                  `[alchemy dev] ${ctx.id}: microvm image rebuild failed`,
                  cause,
                ),
              ),
            ),
          ),
        );
      }),
  });
