import * as integrations from "@distilled.cloud/gcp/integrations_v1";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { isDeleted, lastSegment, locationParent } from "./ownership.ts";

export const parseResourceName = (
  name: string,
  collection: string,
  defaultLocation: string,
) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const collectionAt = parts.lastIndexOf(collection);
  const locationsAt = parts.lastIndexOf("locations");
  const projectsAt = parts.lastIndexOf("projects");
  const instancesAt = parts.lastIndexOf("sfdcInstances");
  return {
    project:
      projectsAt >= 0 && parts[projectsAt + 1] ? parts[projectsAt + 1]! : "",
    location:
      locationsAt >= 0 && parts[locationsAt + 1]
        ? parts[locationsAt + 1]!
        : defaultLocation,
    id:
      collectionAt >= 0 && parts[collectionAt + 1]
        ? parts[collectionAt + 1]!
        : lastSegment(name),
    sfdcInstanceId:
      instancesAt >= 0 && parts[instancesAt + 1] ? parts[instancesAt + 1]! : "",
    sfdcInstance:
      instancesAt >= 0
        ? parts.slice(0, instancesAt + 2).join("/")
        : parts.slice(0, Math.max(0, parts.length - 2)).join("/"),
    parent:
      collectionAt > 0
        ? parts.slice(0, collectionAt).join("/")
        : parts.slice(0, Math.max(0, parts.length - 1)).join("/"),
  };
};

const collectPages = <Page, A, E, R>(
  pages: Stream.Stream<Page, E, R>,
  items: (page: Page) => readonly A[] | undefined,
) =>
  pages.pipe(
    Stream.flatMap((page) => Stream.fromIterable(items(page) ?? [])),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
  );

export const listSfdcInstances = (parent: string) =>
  collectPages(
    integrations.listProjectsLocationsSfdcInstances.pages({
      parent,
      pageSize: 1000,
    }),
    (page) => page.sfdcInstances,
  ).pipe(
    Effect.catchTag("NotFound", () =>
      Effect.succeed(
        [] as integrations.GoogleCloudIntegrationsV1alphaSfdcInstance[],
      ),
    ),
    Effect.map((items) => items.filter((item) => !isDeleted(item))),
  );

export const listSfdcChannels = (parent: string) =>
  collectPages(
    integrations.listProjectsLocationsSfdcInstancesSfdcChannels.pages({
      parent,
      pageSize: 1000,
    }),
    (page) => page.sfdcChannels,
  ).pipe(
    Effect.catchTag("NotFound", () =>
      Effect.succeed(
        [] as integrations.GoogleCloudIntegrationsV1alphaSfdcChannel[],
      ),
    ),
    Effect.map((items) => items.filter((item) => !isDeleted(item))),
  );

export const listTemplates = (parent: string) =>
  collectPages(
    integrations.listProjectsLocationsTemplates.pages({
      parent,
      pageSize: 1000,
    }),
    (page) => page.templates,
  ).pipe(
    Effect.catchTag("NotFound", () =>
      Effect.succeed(
        [] as integrations.GoogleCloudIntegrationsV1alphaTemplate[],
      ),
    ),
  );

export const listOwnedSfdcChannels = (project: string, location: string) =>
  Effect.gen(function* () {
    const instances = yield* listSfdcInstances(
      locationParent(project, location),
    );
    const groups = yield* Effect.forEach(
      instances.filter((instance) => (instance.name ?? "").length > 0),
      (instance) => listSfdcChannels(instance.name!),
      { concurrency: 4 },
    );
    return groups.flat();
  });

export const findSfdcInstanceByDescription = (
  parent: string,
  description: string,
) =>
  listSfdcInstances(parent).pipe(
    Effect.map((items) =>
      items.find((item) => item.description === description),
    ),
  );

export const findSfdcChannelByDescription = (
  parent: string,
  description: string,
) =>
  listSfdcChannels(parent).pipe(
    Effect.map((items) =>
      items.find((item) => item.description === description),
    ),
  );

export const findTemplateByDescription = (
  parent: string,
  description: string,
) =>
  listTemplates(parent).pipe(
    Effect.map((items) =>
      items.find((item) => item.description === description),
    ),
  );
