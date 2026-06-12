import * as organizations from "@distilled.cloud/aws/organizations";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import {
  collectPages,
  readResourceTags,
  retryOrganizations,
  updateResourceTags,
} from "./common.ts";

export type RootId = string;
export type RootArn = string;

export interface RootProps {
  /**
   * Optional root ID to import explicitly.
   * If omitted, Alchemy adopts the single organization root.
   */
  rootId?: string;
  /**
   * Optional root name to match when multiple roots are ever supported.
   */
  name?: string;
  /**
   * Optional tags to apply to the imported root.
   */
  tags?: Record<string, string>;
}

export interface Root extends Resource<
  "AWS.Organizations.Root",
  RootProps,
  {
    rootId: RootId;
    rootArn: RootArn;
    rootName: string;
    policyTypes: organizations.PolicyTypeSummary[];
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * The organization root.
 *
 * `Root` is an import-style resource. It discovers the existing root returned by
 * AWS Organizations and can reconcile root tags.
 */
export const Root = Resource<Root>("AWS.Organizations.Root");

export const RootProvider = () =>
  Provider.effect(
    Root,
    Effect.gen(function* () {
      return {
        stables: ["rootId", "rootArn"],
        diff: Effect.fn(function* ({ olds, news }) {
          if (!isResolved(news)) return;
          if (olds?.rootId !== news?.rootId) {
            return { action: "replace" } as const;
          }
          if (olds?.name !== news?.name) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ olds, output }) {
          return yield* readRoot({
            rootId: output?.rootId ?? olds?.rootId,
            name: olds?.name,
          });
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          // Observe — discover the live root. `Root` is import-only: AWS
          // creates the root for us when the organization is created, and we
          // never create or delete it. We always look it up fresh.
          const root = yield* readRoot({
            rootId: output?.rootId ?? news.rootId,
            name: news.name,
          });
          if (!root) {
            return yield* Effect.fail(
              new Error(
                output?.rootId
                  ? `organization root '${output.rootId}' not found`
                  : "organization root not found",
              ),
            );
          }

          // Sync tags — diff observed cloud tags against desired. Using
          // `root.tags` as the baseline (instead of stale `olds.tags`) keeps
          // the reconciler convergent even on adoption or after drift.
          const tags = yield* updateResourceTags({
            id,
            resourceId: root.rootId,
            olds: root.tags,
            news: news.tags,
          });

          yield* session.note(root.rootArn);
          return {
            ...root,
            tags,
          };
        }),
        delete: Effect.fn(function* () {}),
      };
    }),
  );

const listRoots = () =>
  collectPages(
    (NextToken) => organizations.listRoots({ NextToken }),
    (page) => page.Roots,
  );

const readRoot = Effect.fn(function* ({
  rootId,
  name,
}: {
  rootId?: string;
  name?: string;
}) {
  const roots = yield* retryOrganizations(listRoots());
  const root = roots.find(
    (candidate) =>
      (rootId ? candidate.Id === rootId : true) &&
      (name ? candidate.Name === name : true),
  );

  if (!root?.Id || !root.Arn || !root.Name) {
    return undefined;
  }

  const tags = yield* readResourceTags(root.Id).pipe(
    Effect.catchTag("TargetNotFoundException", () => Effect.succeed({})),
  );

  return {
    rootId: root.Id,
    rootArn: root.Arn,
    rootName: root.Name,
    policyTypes: root.PolicyTypes ?? [],
    tags,
  } satisfies Root["Attributes"];
});
