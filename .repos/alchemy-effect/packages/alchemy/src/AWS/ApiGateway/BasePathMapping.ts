import * as ag from "@distilled.cloud/aws/api-gateway";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import type { Input } from "../../Input.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";

const normalizeBasePath = (basePath: string | undefined) =>
  basePath === undefined || basePath === "" ? "(none)" : basePath;

export interface BasePathMappingProps {
  domainName: string;
  domainNameId?: string;
  /**
   * Base path segment; omit or empty string for root mapping (`(none)` in API Gateway).
   */
  basePath?: string;
  restApiId: Input<string>;
  stage?: string;
}

export interface BasePathMapping extends Resource<
  "AWS.ApiGateway.BasePathMapping",
  BasePathMappingProps,
  {
    domainName: string;
    domainNameId: string | undefined;
    basePath: string;
    restApiId: string;
    stage: string | undefined;
  },
  never,
  Providers
> {}

/**
 * Maps a custom domain name path to a REST API stage.
 *
 * @section Custom domain
 * @example Root mapping
 * ```typescript
 * yield* ApiGateway.BasePathMapping("Root", {
 *   domainName: domain.domainName,
 *   restApiId: api.restApiId,
 *   stage: stage.stageName,
 * });
 * ```
 */
const BasePathMappingResource = Resource<BasePathMapping>(
  "AWS.ApiGateway.BasePathMapping",
);

export { BasePathMappingResource as BasePathMapping };

export const BasePathMappingProvider = () =>
  Provider.effect(
    BasePathMappingResource,
    Effect.gen(function* () {
      return {
        stables: ["domainName", "domainNameId", "basePath"] as const,
        diff: Effect.fn(function* ({ news: newsIn, olds }) {
          if (!isResolved(newsIn)) return;
          const news = newsIn as Input.ResolveProps<BasePathMappingProps>;
          if (
            news.domainName !== olds.domainName ||
            normalizeBasePath(news.basePath) !==
              normalizeBasePath(olds.basePath)
          ) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ output }) {
          if (!output) return undefined;
          const b = yield* ag
            .getBasePathMapping({
              domainName: output.domainName,
              basePath: output.basePath,
              domainNameId: output.domainNameId,
            })
            .pipe(
              Effect.catchTag("NotFoundException", () =>
                Effect.succeed(undefined),
              ),
            );
          if (!b?.restApiId) return undefined;
          return {
            domainName: output.domainName,
            basePath: output.basePath,
            domainNameId: output.domainNameId,
            restApiId: b.restApiId,
            stage: b.stage,
          };
        }),
        reconcile: Effect.fn(function* ({ news: newsIn, output, session }) {
          if (!isResolved(newsIn)) {
            return yield* Effect.die("BasePathMapping props were not resolved");
          }
          const news = newsIn as Input.ResolveProps<BasePathMappingProps>;
          const domainName = output?.domainName ?? news.domainName;
          const domainNameId = output?.domainNameId ?? news.domainNameId;
          const basePath = output?.basePath ?? normalizeBasePath(news.basePath);

          // Observe — basePathmappings are keyed by (domainName, basePath).
          // We never trust `output.restApiId`/`output.stage` for diffing; we
          // re-read the live mapping every time.
          let observed = yield* ag
            .getBasePathMapping({
              domainName,
              basePath,
              domainNameId,
            })
            .pipe(
              Effect.catchTag("NotFoundException", () =>
                Effect.succeed(undefined),
              ),
            );

          // Ensure — create the mapping if it isn't there.
          if (!observed?.restApiId) {
            yield* ag.createBasePathMapping({
              domainName: news.domainName,
              domainNameId: news.domainNameId,
              basePath: basePath === "(none)" ? undefined : news.basePath,
              restApiId: news.restApiId as string,
              stage: news.stage,
            });
            yield* session.note(
              `Created base path mapping ${news.domainName} / ${basePath}`,
            );
            observed = yield* ag.getBasePathMapping({
              domainName,
              basePath,
              domainNameId,
            });
          }

          // Sync mutable fields — diff observed cloud state against desired.
          const desiredRestApiId = news.restApiId as string;
          const patches: ag.PatchOperation[] = [];
          if (desiredRestApiId !== observed.restApiId) {
            patches.push({
              op: "replace" as const,
              path: "/restApiId",
              value: desiredRestApiId,
            });
          }
          if ((news.stage ?? "") !== (observed.stage ?? "")) {
            patches.push({
              op: "replace" as const,
              path: "/stage",
              value: news.stage ?? "",
            });
          }
          if (patches.length > 0) {
            yield* ag.updateBasePathMapping({
              domainName,
              basePath,
              domainNameId,
              patchOperations: patches,
            });
          }

          yield* session.note(`Reconciled base path mapping`);
          const final = yield* ag.getBasePathMapping({
            domainName,
            basePath,
            domainNameId,
          });
          return {
            domainName,
            domainNameId,
            basePath,
            restApiId: final.restApiId!,
            stage: final.stage,
          };
        }),
        delete: Effect.fn(function* ({ output, session }) {
          yield* ag
            .deleteBasePathMapping({
              domainName: output.domainName,
              basePath: output.basePath,
              domainNameId: output.domainNameId,
            })
            .pipe(Effect.catchTag("NotFoundException", () => Effect.void));
          yield* session.note(`Deleted base path mapping`);
        }),
      };
    }),
  );
