import * as apigee from "@distilled.cloud/gcp/apigee_v1";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { GcpEnvironment } from "../Environment.ts";
import { orgParent, organizationOf } from "./names.ts";
import { hasOwnershipMarker } from "./ownership.ts";

export const currentOrganization = (
  explicit: string | undefined,
  existing?: string,
) =>
  Effect.gen(function* () {
    const env = yield* GcpEnvironment.current;
    return organizationOf(explicit, existing, env.project);
  });

export const listOwnedInstances = (organization: string) =>
  apigee.listOrganizationsInstances
    .pages({
      parent: orgParent(organization),
      pageSize: 1000,
    })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.instances ?? [])),
      Stream.filter((instance) => hasOwnershipMarker(instance.description)),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag(["NotFound", "ApigeeResourceNotFound"], () =>
        Effect.succeed([] as apigee.GoogleCloudApigeeV1Instance[]),
      ),
    );
