/** @effect-diagnostics anyUnknownInErrorContext:off */

/**
 * The `alchemy dev` provider for `AWS.Lambda.Function`: deploys the function
 * into the floci emulator and hot-swaps its code on file change.
 *
 * Built on the shared dev-watch skeleton
 * ([DevWatchProvider](../Local/DevWatchProvider.ts)), which owns the
 * RPC-sidecar hosting, the live-provider delegation into the floci override
 * context, the instanceId-guarded watch registry, and the never-bundling dev
 * diff policy. This file supplies only the Lambda-specific parts:
 *
 * - **Watch loop** — a forked `Bundle.watch` (same rolldown config the
 *   deploy used, via [FunctionBundle](./FunctionBundle.ts)) rebuilds on file
 *   change and uploads the fresh archive to a stable per-function S3 key in
 *   the emulator's assets bucket. The first swap repoints the function's
 *   code at that key with `UpdateFunctionCode`, which enrolls floci's
 *   reactive S3 sync; every later swap is a bare `PutObject` (measured
 *   111–138 ms re-extract, warm containers drained, no stale invoke) —
 *   until an engine reconcile re-points the function at a content-addressed
 *   key, after which the next swap re-enrolls it (see `enrolledAttrs`).
 *   `bundle: false` props fs-watch the prebuilt directory instead.
 * - **Replacement rules** — functionName and durableConfig-presence changes
 *   replace, mirroring the live diff.
 * - **Precreate pinning** — floci validates the Handler FILE against the
 *   package at CreateFunction (AWS defers that to first invoke); the 503
 *   stub ships a single `index.*` module, so handler-affecting props are
 *   pinned to the stub's own shape.
 */

import * as Lambda from "@distilled.cloud/aws/lambda";
import * as s3 from "@distilled.cloud/aws/s3";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as Bundle from "../../Bundle/Bundle.ts";
import * as TempRoot from "../../Bundle/TempRoot.ts";
import { Assets, AssetsLive } from "../Assets.ts";
import {
  flociSidecarEntry,
  makeDevWatchProvider,
} from "../Local/DevWatchProvider.ts";
import {
  Function,
  FunctionProvider,
  layerVersionArnOf,
  type FunctionImageProps,
  type FunctionProps,
} from "./Function.ts";
import {
  makeFunctionBundler,
  type FunctionBundleResult,
} from "./FunctionBundle.ts";

const isFunctionImageProps = (
  props: FunctionProps,
): props is FunctionImageProps => props.image !== undefined;

export const FlociFunctionProvider = () =>
  makeDevWatchProvider<Function, FunctionProps, Function["Attributes"]>(
    Function,
    flociSidecarEntry(),
    {
      liveProvider: () => FunctionProvider(),
      // A FRESH `Assets` instance: its cached bucket lookup must resolve
      // against the emulator (auto-bootstrapped there) and can never share a
      // cache with the live arm's instance.
      services: AssetsLive,
      // The restart surface of the watch loop: everything that changes WHAT
      // the watcher builds or WHERE it uploads. `build` may carry plugin
      // closures, which degrade to stable placeholders under canonical
      // hashing.
      watchConfigOf: (news, attrs) =>
        isFunctionImageProps(news)
          ? {
              functionName: attrs.functionName,
              image: news.image,
              architecture: news.architecture,
            }
          : {
              functionName: attrs.functionName,
              main: news.main,
              handler: news.handler,
              bundle: news.bundle,
              isExternal: news.isExternal,
              runtime: news.runtime,
              architecture: news.architecture,
              uploadSourceMap: news.uploadSourceMap,
              build: news.build,
            },
      // Mirrors the live diff's replacement rules.
      replaceOn: ({ olds, news, output }) =>
        Effect.sync(() => {
          const newFunctionName = news.functionName ?? output.functionName;
          if (output.functionName !== newFunctionName) {
            return { action: "replace" as const };
          }
          if (isFunctionImageProps(olds) !== isFunctionImageProps(news)) {
            return {
              action: "replace" as const,
              deleteFirst: news.functionName !== undefined,
            };
          }
          if (
            !isFunctionImageProps(olds) &&
            !isFunctionImageProps(news) &&
            !!olds.durableConfig !== !!news.durableConfig
          ) {
            return {
              action: "replace" as const,
              deleteFirst: news.functionName !== undefined,
            };
          }
          return undefined;
        }),
      normalizeProps: (props) =>
        isFunctionImageProps(props)
          ? props
          : {
              ...props,
              layers: (props.layers ?? []).map(layerVersionArnOf),
            },
      // Floci validates the Handler FILE against the package at
      // CreateFunction (AWS defers that to first invoke). The precreate 503
      // stub ships a single `index.*` module, so a `bundle: false` /
      // custom-handler props set (`handler.handler`) would be rejected — pin
      // the stub's handler-affecting props to the stub's own shape;
      // `reconcile` applies the real Handler together with the real package.
      transformPrecreateNews: (news) =>
        isFunctionImageProps(news)
          ? news
          : {
              ...news,
              bundle: undefined,
              isExternal: undefined,
              handler: undefined,
            },
      startWatch: (ctx) =>
        Effect.gen(function* () {
          const props = ctx.news;
          if (isFunctionImageProps(props)) {
            // Image functions are converged by the delegated live provider.
            // There is no ZIP module graph to watch or hot-swap.
            return;
          }
          const functionName = ctx.attrs.functionName;
          const bundler = yield* makeFunctionBundler;
          const assets = yield* Assets;
          let lastHash = ctx.attrs.code?.hash ?? "";
          // The attributes object that was current when the watch loop
          // last pointed the function at the stable dev key. Every
          // engine-driven reconcile (a binding added, an env var changed,
          // …) re-uploads the bundle to a content-addressed key and
          // re-points the function THERE, silently detaching it from the
          // dev key: floci's reactive S3 sync only follows the key the
          // function is enrolled at, so every later PutObject would be
          // ignored and hot swap would be dead until the next engine
          // update. The skeleton hands the watcher a fresh attrs object per
          // reconcile, so identity (not the code hash — a source edited
          // back to its original content hashes the same) is the signal
          // that a re-point happened and the function must be re-enrolled.
          let enrolledAttrs: Function["Attributes"] | undefined;
          let startedAt = Date.now();

          const swap = Effect.fn(function* (result: FunctionBundleResult) {
            if (result.identityHash === lastHash) return;
            const { archive } = yield* result.buildArchive;
            const bucket = yield* assets.bucketName;
            const key = `lambda/dev/${functionName}.zip`;
            yield* s3.putObject({
              Bucket: bucket,
              Key: key,
              Body: archive,
              ContentType: "application/zip",
            });
            const current = yield* ctx.currentAttrs;
            if (enrolledAttrs !== current) {
              // First swap, or the engine re-pointed the function since the
              // last one: (re)point its code at the stable dev key — floci's
              // reactive S3 sync then re-extracts on every subsequent
              // PutObject with no further Lambda API calls.
              yield* Lambda.updateFunctionCode({
                FunctionName: functionName,
                S3Bucket: bucket,
                S3Key: key,
              }).pipe(
                Effect.retry({
                  while: (e): boolean => e._tag === "ResourceConflictException",
                  schedule: Schedule.exponential(50),
                  times: 8,
                }),
              );
              enrolledAttrs = current;
            }
            lastHash = result.identityHash;
            yield* Effect.logInfo(
              `[alchemy dev] ${functionName}: code swapped in ${Date.now() - startedAt}ms`,
            );
          });

          if (props.bundle === false) {
            // Prebuilt directory: no module graph to watch — fs-watch the
            // directory and re-zip it as-is (exactly like `prebuiltCode`).
            const fs = yield* FileSystem.FileSystem;
            const realMain = yield* TempRoot.resolveMainPath(props.main);
            const dir = realMain.slice(0, realMain.lastIndexOf("/"));
            yield* fs.watch(dir, { recursive: true }).pipe(
              Stream.debounce("200 millis"),
              Stream.runForEach(() =>
                Effect.gen(function* () {
                  startedAt = Date.now();
                  const result = yield* bundler.prebuiltCode(realMain);
                  yield* swap(result);
                }).pipe(
                  Effect.catchCause((cause) =>
                    Effect.logWarning(
                      `[alchemy dev] ${functionName}: code swap failed`,
                      cause,
                    ),
                  ),
                ),
              ),
            );
          } else {
            // The exact rolldown config the deploy used — incremental
            // rebuilds produce the identical artifact shape.
            const plan = yield* bundler.resolveBundlePlan(props);
            yield* Bundle.watch(
              plan.inputOptions,
              plan.outputOptions,
              plan.extra,
            ).pipe(
              Stream.runForEach((event) =>
                Effect.gen(function* () {
                  switch (event._tag) {
                    case "Start": {
                      startedAt = Date.now();
                      return;
                    }
                    case "Error": {
                      yield* Effect.logWarning(
                        `[alchemy dev] ${functionName}: rebuild failed: ${event.error.message}`,
                      );
                      return;
                    }
                    case "Success": {
                      const result = yield* bundler.finishBundle(
                        plan,
                        event.output,
                      );
                      yield* swap(result);
                    }
                  }
                }).pipe(
                  Effect.catchCause((cause) =>
                    Effect.logWarning(
                      `[alchemy dev] ${functionName}: code swap failed`,
                      cause,
                    ),
                  ),
                ),
              ),
            );
          }
        }),
    },
  );
