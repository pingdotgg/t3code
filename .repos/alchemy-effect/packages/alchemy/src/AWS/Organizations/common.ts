import * as organizations from "@distilled.cloud/aws/organizations";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { createPhysicalName } from "../../PhysicalName.ts";
import { createInternalTags, diffTags } from "../../Tags.ts";

export type OrganizationsTags = Record<string, string>;

export const createName = (
  id: string,
  providedName: string | undefined,
  maxLength: number,
) =>
  providedName
    ? Effect.succeed(providedName)
    : createPhysicalName({
        id,
        maxLength,
      });

export const toTagRecord = (
  tags: organizations.Tag[] | undefined,
): OrganizationsTags =>
  Object.fromEntries(
    (tags ?? [])
      .filter(
        (tag): tag is { Key: string; Value: string } =>
          typeof tag.Key === "string" && typeof tag.Value === "string",
      )
      .map((tag) => [tag.Key, tag.Value]),
  );

export const collectPages = <Page extends { NextToken?: string }, Item, E, R>(
  fetch: (nextToken?: string) => Effect.Effect<Page, E, R>,
  select: (page: Page) => ReadonlyArray<Item> | undefined,
) =>
  Effect.gen(function* () {
    const items: Item[] = [];
    let nextToken: string | undefined;

    do {
      const page = yield* fetch(nextToken);
      items.push(...(select(page) ?? []));
      nextToken = page.NextToken;
    } while (nextToken);

    return items;
  });

export const retryOrganizations = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.retry({
      while: (error: any) =>
        error?._tag === "ConcurrentModificationException" ||
        error?._tag === "TooManyRequestsException" ||
        error?._tag === "ServiceException" ||
        error?._tag === "FinalizingOrganizationException",
      schedule: Schedule.exponential(200).pipe(
        Schedule.both(Schedule.recurs(8)),
      ),
    }),
  );

export const createManagedTags = Effect.fn(function* (
  id: string,
  tags: Record<string, string> | undefined,
) {
  return {
    ...(yield* createInternalTags(id)),
    ...(tags ?? {}),
  };
});

export const readResourceTags = (resourceId: string) =>
  collectPages(
    (NextToken) =>
      organizations.listTagsForResource({ ResourceId: resourceId, NextToken }),
    (page) => page.Tags,
  ).pipe(Effect.map(toTagRecord));

export const updateResourceTags = Effect.fn(function* ({
  id,
  resourceId,
  olds,
  news,
}: {
  id: string;
  resourceId: string;
  olds: Record<string, string> | undefined;
  news: Record<string, string> | undefined;
}) {
  const oldTags = yield* createManagedTags(id, olds);
  const newTags = yield* createManagedTags(id, news);
  const { removed, upsert } = diffTags(oldTags, newTags);

  if (removed.length > 0) {
    yield* retryOrganizations(
      organizations.untagResource({
        ResourceId: resourceId,
        TagKeys: removed,
      }),
    );
  }

  if (upsert.length > 0) {
    yield* retryOrganizations(
      organizations.tagResource({
        ResourceId: resourceId,
        Tags: upsert,
      }),
    );
  }

  return newTags;
});
