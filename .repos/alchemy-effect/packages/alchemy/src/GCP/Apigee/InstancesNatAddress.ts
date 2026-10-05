import * as apigee from "@distilled.cloud/gcp/apigee_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  lastSegment,
  orgParent,
  organizationFromName,
  toResourceId,
} from "./names.ts";
import { waitForOperation } from "./operations.ts";
import { listOwnedInstances } from "./org.ts";

const MAX_NAME_LENGTH = 32;

export type InstancesNatAddressProps = {
  /**
   * Apigee organization id. Defaults to the current GCP project id.
   * Immutable — changing it replaces the NAT address.
   */
  organization?: string;
  /**
   * Parent instance id or full name
   * (`organizations/{org}/instances/{instance}`). Immutable — changing it
   * replaces the NAT address.
   */
  instance: string;
  /**
   * NAT address id (the `{nataddress}` segment of
   * `organizations/{org}/instances/{instance}/natAddresses/{nataddress}`).
   * If omitted, a unique name is generated from the stack, stage, and
   * logical id. Immutable — changing it replaces the NAT address.
   */
  natAddressId?: string;
  /**
   * When true, activate the address after it reaches `RESERVED` so the
   * instance uses it for Internet egress. Activation is one-way.
   * @default false
   */
  activate?: boolean;
};

export type InstancesNatAddress = Resource<
  "GCP.Apigee.InstancesNatAddress",
  InstancesNatAddressProps,
  {
    /** Full resource name `organizations/{org}/instances/{instance}/natAddresses/{nataddress}`. */
    name: string;
    /** NAT address id (last path segment). */
    natAddressId: string;
    /** Parent instance id. */
    instanceId: string;
    /** Apigee organization id. */
    organization: string;
    /** Provisioned static IPv4 address, if assigned. */
    ipAddress: string | undefined;
    /** Server-reported state (`CREATING`, `RESERVED`, `ACTIVE`, `DELETING`). */
    state: string | undefined;
  },
  never,
  Providers
>;

/**
 * A static NAT address on an Apigee runtime instance.
 *
 * NAT addresses have no labels or description. `list` enumerates
 * addresses on alchemy-owned instances so `pnpm nuke:gcp` can find
 * leaked rows. Organization, instance, and name are identity — changing
 * them replaces the address. `activate` updates in place (RESERVED →
 * ACTIVE) and cannot be reversed.
 *
 * ### Creating a NAT Address
 * **Example:** Reserve a NAT address on a runtime instance
 * ```typescript
 * const runtime = yield* GCP.Apigee.Instance("Runtime", {});
 * const nat = yield* GCP.Apigee.InstancesNatAddress("Egress", {
 *   instance: runtime.name,
 * });
 * ```
 *
 * **Example:** Reserve and activate
 * ```typescript
 * const nat = yield* GCP.Apigee.InstancesNatAddress("Egress", {
 *   instance: runtime.name,
 *   natAddressId: "app-egress",
 *   activate: true,
 * });
 * ```
 *
 * @resource
 * @category Apigee
 */
export const InstancesNatAddress = Resource<InstancesNatAddress>(
  "GCP.Apigee.InstancesNatAddress",
);

export class InstancesNatAddressNotResolved extends Data.TaggedError(
  "GCP.Apigee.InstancesNatAddressNotResolved",
)<{
  name: string;
}> {}

export class InstancesNatAddressNotReady extends Data.TaggedError(
  "GCP.Apigee.InstancesNatAddressNotReady",
)<{
  name: string;
  state: string;
}> {}

const instanceIdOf = (instance: string) => lastSegment(instance);

const instanceName = (organization: string, instance: string) =>
  instance.includes("/")
    ? instance
    : `${orgParent(organization)}/instances/${instance}`;

const resourceName = (
  organization: string,
  instance: string,
  natAddressId: string,
) => `${instanceName(organization, instance)}/natAddresses/${natAddressId}`;

const toAttrs = (
  address: apigee.GoogleCloudApigeeV1NatAddress,
  organization: string,
  instanceId: string,
) => {
  const raw = address.name ?? "";
  const name = raw.includes("/")
    ? raw
    : resourceName(organization, instanceId, raw);
  return {
    name,
    natAddressId: lastSegment(name),
    instanceId,
    organization: organizationFromName(name) ?? organization,
    ipAddress: address.ipAddress,
    state: address.state,
  };
};

const getByName = (name: string) =>
  apigee
    .getOrganizationsInstancesNatAddresses({ name })
    .pipe(
      Effect.catchTag(["NotFound", "ApigeeResourceNotFound"], () =>
        Effect.succeed(undefined),
      ),
    );

const listByInstance = (parent: string) =>
  apigee.listOrganizationsInstancesNatAddresses
    .pages({
      parent,
      pageSize: 1000,
    })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.natAddresses ?? [])),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag(["NotFound", "ApigeeResourceNotFound"], () =>
        Effect.succeed([] as apigee.GoogleCloudApigeeV1NatAddress[]),
      ),
    );

const waitUntilState = (name: string, allowed: ReadonlySet<string>) =>
  getByName(name).pipe(
    Effect.filterOrFail(
      (address): address is apigee.GoogleCloudApigeeV1NatAddress =>
        address !== undefined,
      () => new InstancesNatAddressNotResolved({ name }),
    ),
    Effect.filterOrFail(
      (address) => allowed.has(address.state ?? "STATE_UNSPECIFIED"),
      (address) =>
        new InstancesNatAddressNotReady({
          name,
          state: address.state ?? "STATE_UNSPECIFIED",
        }),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.Apigee.InstancesNatAddressNotReady" ||
        error._tag === "GCP.Apigee.InstancesNatAddressNotResolved",
      times: 8,
      schedule: Schedule.spaced("5 seconds"),
    }),
  );

export const InstancesNatAddressProvider = () =>
  Provider.succeed(InstancesNatAddress, {
    stables: ["name", "natAddressId", "instanceId", "organization"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId = olds?.natAddressId ?? output?.natAddressId;
      const previousInstance = olds?.instance ?? output?.instanceId;
      const previousOrg = olds?.organization ?? output?.organization;
      if (
        (previousId !== undefined &&
          news.natAddressId !== undefined &&
          news.natAddressId !== previousId) ||
        (previousInstance !== undefined &&
          instanceIdOf(news.instance) !== instanceIdOf(previousInstance)) ||
        (previousOrg !== undefined &&
          news.organization !== undefined &&
          news.organization !== previousOrg)
      ) {
        return { action: "replace" as const, deleteFirst: true };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const organization =
        organizationFromName(output?.name) ?? olds?.organization ?? env.project;
      const instanceId = instanceIdOf(
        olds?.instance ?? output?.instanceId ?? "",
      );
      if (instanceId.length === 0) return undefined;
      const natAddressId = yield* toResourceId(
        id,
        olds?.natAddressId,
        output?.natAddressId,
        MAX_NAME_LENGTH,
      );
      const name =
        output?.name ?? resourceName(organization, instanceId, natAddressId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      return toAttrs(existing, organization, instanceId);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const instances = yield* listOwnedInstances(env.project);
        const pages = yield* Effect.forEach(
          instances,
          (instance) => {
            const parent = instance.name?.includes("/")
              ? instance.name
              : `${orgParent(env.project)}/instances/${lastSegment(instance.name ?? "")}`;
            const instanceId = lastSegment(parent);
            return listByInstance(parent).pipe(
              Effect.map((addresses) =>
                addresses.map((address) =>
                  toAttrs(address, env.project, instanceId),
                ),
              ),
            );
          },
          { concurrency: 4 },
        );
        return pages.flat();
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const organization =
        news.organization ?? output?.organization ?? env.project;
      const instanceId = instanceIdOf(news.instance);
      const natAddressId = yield* toResourceId(
        id,
        news.natAddressId,
        output?.natAddressId,
        MAX_NAME_LENGTH,
      );
      const parent = instanceName(organization, instanceId);
      const name = resourceName(organization, instanceId, natAddressId);

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* apigee
          .createOrganizationsInstancesNatAddresses({
            parent,
            body: { name: natAddressId },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          yield* waitForOperation(created, { alreadyExistsOk: true });
        }
        current = yield* getByName(name);
      }

      if (current === undefined) {
        return yield* new InstancesNatAddressNotResolved({ name });
      }

      if ((current.state ?? "") === "CREATING") {
        current =
          (yield* waitUntilState(name, new Set(["RESERVED", "ACTIVE"])).pipe(
            Effect.catchTag("GCP.Apigee.InstancesNatAddressNotReady", () =>
              getByName(name),
            ),
          )) ?? current;
      }

      if (news.activate === true && (current.state ?? "") === "RESERVED") {
        const activated =
          yield* apigee.activateOrganizationsInstancesNatAddresses({
            name: current.name?.includes("/") ? current.name : name,
            body: {},
          });
        yield* waitForOperation(activated);
        current = (yield* getByName(name)) ?? current;
      }

      return toAttrs(current, organization, instanceId);
    }),

    delete: Effect.fn(function* ({ output }) {
      const deleted = yield* apigee
        .deleteOrganizationsInstancesNatAddresses({ name: output.name })
        .pipe(
          Effect.catchTag(["NotFound", "ApigeeResourceNotFound"], () =>
            Effect.succeed(undefined),
          ),
        );
      if (deleted !== undefined) {
        yield* waitForOperation(deleted, { notFoundOk: true });
      }
    }),
  });
