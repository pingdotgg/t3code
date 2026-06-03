import * as ag from "@distilled.cloud/aws/api-gateway";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import type { Input } from "../../Input.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";

export interface UsagePlanKeyProps {
  usagePlanId: Input<string>;
  keyId: Input<string>;
  /**
   * @default "API_KEY"
   */
  keyType?: string;
}

export interface UsagePlanKey extends Resource<
  "AWS.ApiGateway.UsagePlanKey",
  UsagePlanKeyProps,
  {
    usagePlanId: string;
    keyId: string;
    keyType: string;
    name: string | undefined;
  },
  never,
  Providers
> {}

/**
 * Associates an API key with a usage plan.
 *
 * @section Usage plan keys
 * @example Associate key with plan
 * ```typescript
 * yield* ApiGateway.UsagePlanKey("PlanKey", {
 *   usagePlanId: plan.id,
 *   keyId: key.id,
 * });
 * ```
 */
const UsagePlanKeyResource = Resource<UsagePlanKey>(
  "AWS.ApiGateway.UsagePlanKey",
);

export { UsagePlanKeyResource as UsagePlanKey };

export const UsagePlanKeyProvider = () =>
  Provider.effect(
    UsagePlanKeyResource,
    Effect.gen(function* () {
      return {
        stables: ["usagePlanId", "keyId"] as const,
        diff: Effect.fn(function* ({ news: newsIn, olds }) {
          if (!isResolved(newsIn)) return;
          const news = newsIn as UsagePlanKeyProps;
          if (
            news.usagePlanId !== olds.usagePlanId ||
            news.keyId !== olds.keyId
          ) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ output }) {
          if (!output) return undefined;
          const k = yield* ag
            .getUsagePlanKey({
              usagePlanId: output.usagePlanId,
              keyId: output.keyId,
            })
            .pipe(
              Effect.catchTag("NotFoundException", () =>
                Effect.succeed(undefined),
              ),
            );
          if (!k?.id) return undefined;
          return {
            usagePlanId: output.usagePlanId,
            keyId: k.id,
            keyType: k.type ?? "API_KEY",
            name: k.name,
          };
        }),
        reconcile: Effect.fn(function* ({ news: newsIn, output, session }) {
          if (!isResolved(newsIn)) {
            return yield* Effect.die("UsagePlanKey props were not resolved");
          }
          const news = newsIn as Input.ResolveProps<UsagePlanKeyProps>;
          const usagePlanId = (output?.usagePlanId ??
            news.usagePlanId) as string;
          const keyId = (output?.keyId ?? news.keyId) as string;

          // Observe — fetch the live link. UsagePlanKey is a pure
          // association (no patchable fields apart from the natural-key
          // tuple, which is modeled as `replace` in `diff`), so once it
          // exists there's nothing to sync.
          let observed = yield* ag
            .getUsagePlanKey({ usagePlanId, keyId })
            .pipe(
              Effect.catchTag("NotFoundException", () =>
                Effect.succeed(undefined),
              ),
            );

          // Ensure — create the link if missing.
          if (!observed?.id) {
            const created = yield* ag.createUsagePlanKey({
              usagePlanId: news.usagePlanId as string,
              keyId: news.keyId as string,
              keyType: news.keyType ?? "API_KEY",
            });
            yield* session.note(
              `Linked key ${news.keyId} to usage plan ${news.usagePlanId}`,
            );
            observed = yield* ag.getUsagePlanKey({
              usagePlanId,
              keyId: created.id ?? keyId,
            });
          }

          return {
            usagePlanId,
            keyId: observed.id!,
            keyType: observed.type ?? "API_KEY",
            name: observed.name,
          };
        }),
        delete: Effect.fn(function* ({ output, session }) {
          yield* ag
            .deleteUsagePlanKey({
              usagePlanId: output.usagePlanId,
              keyId: output.keyId,
            })
            .pipe(Effect.catchTag("NotFoundException", () => Effect.void));
          yield* session.note(`Removed key from usage plan`);
        }),
      };
    }),
  );
