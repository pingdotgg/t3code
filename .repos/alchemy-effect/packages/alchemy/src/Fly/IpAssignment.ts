import type { IPAssignment as FlyIPAssignment } from "@distilled.cloud/fly-io/machines";
import * as machines from "@distilled.cloud/fly-io/machines";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { listOwnedApps } from "./App.ts";
import type { App } from "./App.ts";
import type { Providers } from "./Providers.ts";

/**
 * A resource-valued prop: the resource itself, or an Effect that produces
 * it (so `yield* App(...)` and `App(...)` both type-check).
 */
type Ref<T> = T | Effect.Effect<T, never, Providers>;

/**
 * Fly IP family allocated onto an App. Dedicated `v4` is billed and may
 * be rejected when the org has no IPv4 quota. Prefer `v6` (free) or
 * `shared_v4` (free) in tests. `private_v6` is a Flycast address: it is
 * reachable only from the organization's private network.
 */
export type IpAssignmentType = "v4" | "v6" | "shared_v4" | "private_v6";

export interface IpAssignmentProps {
  /**
   * Parent Fly App. Accepts a `Fly.App` resource or an Effect that
   * produces one. Changing the App replaces the assignment.
   */
  app: Ref<App>;
  /**
   * Address family to allocate. `v6` is a dedicated IPv6 (free).
   * `shared_v4` is a shared Anycast IPv4 (free). `v4` is a dedicated
   * IPv4 (billed; may 400 when the org is over quota). `private_v6` is
   * a Flycast IPv6 (free) that Fly's proxy serves only inside the
   * private network. Changing type replaces the assignment.
   */
  type: IpAssignmentType;
  /**
   * Region for a dedicated address. Changing it replaces the assignment.
   */
  region?: string;
  /**
   * Private network a `private_v6` address is reachable from. Defaults
   * to the organization's network. Create-only; changing it replaces.
   */
  network?: string;
  /**
   * Organization slug. Defaults to the current token's org. Not a
   * replacement key.
   */
  orgSlug?: string;
  /**
   * Fly proxy service this address is bound to. Changing it replaces
   * the assignment.
   */
  serviceName?: string;
}

export type IpAssignment = Resource<
  "Fly.IpAssignment",
  IpAssignmentProps,
  {
    /** Physical Fly App name the address is assigned to. */
    appName: string;
    /** Allocated address. Identity of the assignment. */
    ip: string;
    /** Observed address family. */
    type: IpAssignmentType;
    /** Region for a dedicated address, if set. */
    region: string | undefined;
    /** Fly proxy service this address is bound to, if set. */
    serviceName: string | undefined;
    /** Whether the address is a shared Anycast IPv4. */
    shared: boolean;
    /**
     * Named private network a `private_v6` address is reachable from.
     * `undefined` for the organization's default network and for public
     * addresses.
     */
    network: string | undefined;
    /** RFC3339 creation timestamp, if the API returned one. */
    createdAt: string | undefined;
  },
  never,
  Providers
>;

const resolveIpAssignmentProps = (
  props: IpAssignmentProps | Effect.Effect<IpAssignmentProps, never, Providers>,
): Effect.Effect<IpAssignmentProps, never, Providers> =>
  Effect.gen(function* () {
    const resolved = Effect.isEffect(props) ? yield* props : props;
    if (globalThis.__ALCHEMY_RUNTIME__) return resolved;
    const app = Effect.isEffect(resolved.app)
      ? yield* resolved.app as Effect.Effect<App, never, Providers>
      : resolved.app;
    return { ...resolved, app };
  });

const IpAssignmentResource = Resource<IpAssignment>("Fly.IpAssignment");

/**
 * A Fly.IpAssignment is an address on an {@link App}. A {@link Service}
 * publishes ports. Fly's proxy load-balances `{app}.fly.dev` across
 * Machines that publish a proxy service.
 *
 * Identity is the allocated `ip`. There is no in-place update.
 *
 * @see https://fly.io/docs/networking/services/
 *
 * ### Shared IPv4
 * `shared_v4` is a shared Anycast IPv4. It is free. This is what you
 * want for fly.dev over IPv4. Yield it next to the Service.
 *
 * **Example:** Allocate shared_v4
 * ```typescript
 * export const PublicIp = Fly.IpAssignment("Shared", {
 *   app: Site,
 *   type: "shared_v4",
 * });
 * ```
 *
 * :::caution[Changing `type` or `app` replaces the assignment]
 * A new address is allocated. The old one is released.
 * :::
 *
 * ### Dedicated IPv6
 * `v6` is a dedicated IPv6. It is free.
 *
 * **Example:** Allocate v6
 * ```typescript
 * export const V6 = Fly.IpAssignment("V6", {
 *   app: Site,
 *   type: "v6",
 * });
 * ```
 *
 * ### Dedicated IPv4
 * `v4` is a billed dedicated IPv4. It may 400 if the org has no
 * quota. Prefer `shared_v4` or `v6` in tests.
 *
 * **Example:** Allocate v4
 * ```typescript
 * export const Dedicated = Fly.IpAssignment("Dedicated", {
 *   app: Site,
 *   type: "v4",
 * });
 * ```
 *
 * ### Flycast (private IPv6)
 * `private_v6` is a Flycast address. Fly's proxy serves it only inside
 * the organization's private network, at `{app}.flycast`. It is free.
 * Use it for a backend that another App calls and the internet must
 * not reach. Requests still go through the proxy, so blue/green
 * cordoning, `autostart`, and `autostop` keep working. Allocate no
 * public address on the same App.
 *
 * **Example:** Allocate private_v6
 * ```typescript
 * export const Private = Fly.IpAssignment("Private", {
 *   app: Backend,
 *   type: "private_v6",
 * });
 * ```
 *
 * ### Region
 * `region` pins a dedicated address. Shared Anycast ignores it. See
 * [Regions](/fly/compute/regions) for the list of codes.
 *
 * **Example:** Dedicated IPv4 in iad
 * ```typescript
 * export const Dedicated = Fly.IpAssignment("Dedicated", {
 *   app: Site,
 *   type: "v4",
 *   region: "iad",
 * });
 * ```
 *
 * :::caution[Changing `region` replaces the assignment]
 * A new address is allocated in the new region.
 * :::
 *
 * ### Service name
 * `serviceName` binds the address to a Fly proxy service. Changing it
 * replaces the assignment.
 *
 * **Example:** Bind to a named service
 * ```typescript
 * export const PublicIp = Fly.IpAssignment("Shared", {
 *   app: Site,
 *   type: "shared_v4",
 *   serviceName: "http",
 * });
 * ```
 *
 * :::caution[Changing `serviceName` replaces the assignment]
 * A new address is allocated bound to the new service.
 * :::
 *
 * ### Isolated network
 * `network` names the private network a `private_v6` address is
 * reachable from. Create-only.
 *
 * **Example:** Custom network
 * ```typescript
 * export const Private = Fly.IpAssignment("Private", {
 *   app: Backend,
 *   type: "private_v6",
 *   network: "tenant-a",
 * });
 * ```
 *
 * :::caution[Changing `network` replaces the assignment]
 * A new address is allocated on the new network.
 * :::
 *
 * ### Organization
 * `orgSlug` defaults to the current token's org. It is not a
 * replacement key.
 *
 * **Example:** Pin an org
 * ```typescript
 * export const PublicIp = Fly.IpAssignment("Shared", {
 *   app: Site,
 *   type: "shared_v4",
 *   orgSlug: "my-org",
 * });
 * ```
 *
 * ### Yield with a Service
 * Allocate the address on the same App as the Service. `api.url` is
 * `https://{appName}.fly.dev`.
 *
 * **Example:** Stack outputs
 * ```typescript
 * export default Alchemy.Stack(
 *   "MyApp",
 *   { providers: Fly.providers(), state: Alchemy.localState() },
 *   Effect.gen(function* () {
 *     const api = yield* Api;
 *     const ip = yield* PublicIp;
 *     return { url: api.url, ip: ip.ip };
 *   }),
 * );
 * ```
 *
 * @resource
 * @product App
 */
export const IpAssignment: typeof IpAssignmentResource = Object.assign(
  (
    id: string,
    props:
      | IpAssignmentProps
      | Effect.Effect<IpAssignmentProps, never, Providers>,
  ) => IpAssignmentResource(id, resolveIpAssignmentProps(props)),
  IpAssignmentResource,
);

export class IpAssignmentNotCreated extends Data.TaggedError(
  "Fly.IpAssignmentNotCreated",
)<{
  appName: string;
  type: IpAssignmentType;
}> {}

export class IpAssignmentAppMissing extends Data.TaggedError(
  "Fly.IpAssignmentAppMissing",
)<{
  type: IpAssignmentType;
}> {}

const appNameOf = (value: unknown): string | undefined => {
  if (value === null || typeof value !== "object") return undefined;
  const rec = value as { appName?: unknown; name?: unknown };
  if (typeof rec.appName === "string" && rec.appName.length > 0) {
    return rec.appName;
  }
  if (typeof rec.name === "string" && rec.name.length > 0) {
    return rec.name;
  }
  return undefined;
};

const asType = (value: string | undefined): IpAssignmentType | undefined =>
  value === "v4" ||
  value === "v6" ||
  value === "shared_v4" ||
  value === "private_v6"
    ? value
    : undefined;

/**
 * Fly omits `type` from IP assignment responses. Only Flycast addresses carry
 * a `network` (its name is empty for the organization's default network).
 */
const isFlycast = (assignment: FlyIPAssignment) =>
  assignment.network !== undefined && assignment.network !== null;

const networkOf = (assignment: FlyIPAssignment) =>
  assignment.network?.name || undefined;

const inferType = (
  assignment: FlyIPAssignment,
  fallback?: IpAssignmentType,
): IpAssignmentType => {
  const wire = asType(assignment.type);
  if (wire !== undefined) return wire;
  if (assignment.shared === true) return "shared_v4";
  if (isFlycast(assignment)) return "private_v6";
  const ip = assignment.ip ?? "";
  if (ip.includes(":")) return "v6";
  if (fallback !== undefined) return fallback;
  return ip.length > 0 ? "v4" : (fallback ?? "v4");
};

const toAttrs = (
  appName: string,
  assignment: FlyIPAssignment,
  fallbackType?: IpAssignmentType,
): IpAssignment["Attributes"] => {
  const type = inferType(assignment, fallbackType);
  return {
    appName,
    ip: assignment.ip ?? "",
    type,
    region: assignment.region,
    serviceName: assignment.service_name,
    shared: type === "shared_v4" || assignment.shared === true,
    network: networkOf(assignment),
    createdAt: assignment.created_at,
  };
};

const matchesDesired = (
  assignment: FlyIPAssignment,
  news: Pick<IpAssignmentProps, "type" | "region" | "serviceName" | "network">,
): boolean => {
  if (inferType(assignment, news.type) !== news.type) return false;
  if (news.type === "private_v6" && networkOf(assignment) !== news.network)
    return false;
  if (news.region !== undefined && assignment.region !== news.region) {
    return false;
  }
  if (
    news.serviceName !== undefined &&
    assignment.service_name !== news.serviceName
  ) {
    return false;
  }
  return true;
};

const listAssignments = (appName: string) =>
  machines.listAppIPAssignments({ app_name: appName }).pipe(
    Effect.map((res) => res.ips ?? []),
    Effect.catchTag(["NotFound", "Forbidden"], () =>
      Effect.succeed([] as FlyIPAssignment[]),
    ),
  );

const findByIp = (appName: string, ip: string) =>
  listAssignments(appName).pipe(
    Effect.map((ips) => ips.find((item) => item.ip === ip)),
  );

const findMatching = (
  appName: string,
  news: Pick<IpAssignmentProps, "type" | "region" | "serviceName" | "network">,
) =>
  listAssignments(appName).pipe(
    Effect.map((ips) => ips.find((item) => matchesDesired(item, news))),
  );

const waitUntilGone = (appName: string, ip: string) =>
  findByIp(appName, ip).pipe(
    Effect.map((found) => found === undefined),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (gone) => gone,
      times: 8,
    }),
  );

/** Whether the App has any address reachable from the internet. */
export const hasPublicAddress = (appName: string) =>
  listAssignments(appName).pipe(
    Effect.map((ips) => ips.some((item) => inferType(item) !== "private_v6")),
  );

/**
 * Converge the addresses of an App a {@link Service} owns. Every owned App
 * gets a Flycast address on its private network (the organization's
 * default network when `network` is omitted). A public App also gets a
 * shared IPv4 and an IPv6; a private one has every public address
 * released. All three types are free.
 */
export const syncOwnedAppAddresses = Effect.fn(function* (
  appName: string,
  isPublic: boolean,
  network?: string,
) {
  const observed = yield* listAssignments(appName);
  const isDesiredFlycast = (item: FlyIPAssignment) =>
    inferType(item) === "private_v6" && networkOf(item) === network;
  if (!observed.some(isDesiredFlycast)) {
    yield* machines
      .createAppIPAssignment({ app_name: appName, type: "private_v6", network })
      .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
  }
  if (isPublic) {
    for (const type of ["shared_v4", "v6"] as const) {
      if (observed.some((item) => inferType(item) === type)) continue;
      yield* machines
        .createAppIPAssignment({ app_name: appName, type })
        .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
    }
  }
  // Release public addresses of a private Service and Flycast addresses
  // on any other network.
  for (const item of observed) {
    if (item.ip === undefined || isDesiredFlycast(item)) continue;
    if (isPublic && inferType(item) !== "private_v6") continue;
    yield* machines
      .deleteAppIPAssignment({ app_name: appName, ip: item.ip })
      .pipe(Effect.catchTag("NotFound", () => Effect.void));
    yield* waitUntilGone(appName, item.ip);
  }
});

/**
 * Add a Flycast address on `network` to an App a {@link Service} shares,
 * so bound callers can reach it. Only ever adds; the address is removed
 * with the App.
 */
export const ensureFlycastAddress = Effect.fn(function* (
  appName: string,
  network?: string,
) {
  const observed = yield* listAssignments(appName);
  if (
    observed.some(
      (item) => inferType(item) === "private_v6" && networkOf(item) === network,
    )
  )
    return;
  yield* machines
    .createAppIPAssignment({ app_name: appName, type: "private_v6", network })
    .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
});

export const IpAssignmentProvider = () =>
  Provider.succeed(IpAssignment, {
    stables: ["ip", "appName", "type", "region"],
    nuke: { dependsOn: ["Fly.App"] },

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (news === undefined || !isResolved(news)) return undefined;
      if (output === undefined) return undefined;
      const appName = appNameOf(news.app);
      const appChanged = appName !== undefined && appName !== output.appName;
      const typeChanged = news.type !== output.type;
      const regionChanged =
        news.region !== undefined && news.region !== output.region;
      const serviceChanged =
        news.serviceName !== undefined &&
        news.serviceName !== output.serviceName;
      const networkChanged =
        news.network !== (olds !== undefined ? olds.network : output.network);
      if (
        appChanged ||
        typeChanged ||
        regionChanged ||
        serviceChanged ||
        networkChanged
      ) {
        return { action: "replace" as const };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const appName = output?.appName ?? appNameOf(olds?.app);
      if (appName === undefined) return undefined;
      const found =
        output?.ip !== undefined && output.ip.length > 0
          ? yield* findByIp(appName, output.ip)
          : olds !== undefined
            ? yield* findMatching(appName, olds)
            : undefined;
      if (found === undefined || found.ip === undefined) return undefined;
      return toAttrs(appName, found, output?.type ?? olds?.type);
    }),

    list: Effect.fn(function* () {
      const apps = yield* listOwnedApps();
      const rows = yield* Effect.forEach(
        apps,
        (app) =>
          listAssignments(app.appName).pipe(
            Effect.map((ips) =>
              ips
                .filter((item) => item.ip !== undefined && item.ip.length > 0)
                .map((item) => toAttrs(app.appName, item)),
            ),
          ),
        { concurrency: 8 },
      );
      return rows.flat();
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const props = news ?? ({} as IpAssignmentProps);
      const appName = appNameOf(props.app) ?? output?.appName;
      if (appName === undefined) {
        return yield* new IpAssignmentAppMissing({
          type: props.type,
        });
      }

      // Observe by cached ip, then by desired type/region/service.
      let current =
        output?.ip !== undefined && output.ip.length > 0
          ? yield* findByIp(appName, output.ip)
          : undefined;
      if (current === undefined) {
        current = yield* findMatching(appName, props);
      }

      if (current === undefined) {
        const created = yield* machines
          .createAppIPAssignment({
            app_name: appName,
            type: props.type,
            region: props.region,
            network: props.network,
            org_slug: props.orgSlug,
            service_name: props.serviceName,
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined && created.ip !== undefined) {
          current = created;
        } else {
          current = yield* findMatching(appName, props);
        }
      }

      if (current === undefined || current.ip === undefined) {
        return yield* new IpAssignmentNotCreated({
          appName,
          type: props.type,
        });
      }

      return toAttrs(appName, current, props.type);
    }),

    delete: Effect.fn(function* ({ output }) {
      const appName = output.appName;
      const ip = output.ip;
      if (appName.length === 0 || ip.length === 0) return;
      yield* machines
        .deleteAppIPAssignment({
          app_name: appName,
          ip,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
      yield* waitUntilGone(appName, ip);
    }),
  });
