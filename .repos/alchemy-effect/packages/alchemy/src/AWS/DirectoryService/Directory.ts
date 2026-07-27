import * as ds from "@distilled.cloud/aws/directory-service";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, diffTags, hasAlchemyTags } from "../../Tags.ts";
import { AWSEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { readDirectoryTags, sameStringSet } from "./internal.ts";

/** The kind of managed directory to launch. */
export type DirectoryFlavor = "SimpleAD" | "MicrosoftAD";

export interface DirectoryProps {
  /**
   * Which managed directory to launch — a Samba-based `"SimpleAD"` or an
   * actual `"MicrosoftAD"` (AWS Managed Microsoft AD). Changing the flavor
   * replaces the directory.
   * @default "SimpleAD"
   */
  type?: DirectoryFlavor;
  /**
   * Fully qualified domain name of the directory, e.g. `corp.example.com`.
   * The domain does not need to be publicly resolvable. Changing the name
   * replaces the directory.
   */
  name: string;
  /**
   * NetBIOS short name of the directory, e.g. `CORP`. Changing the short
   * name replaces the directory.
   * @default the first label of `name`
   */
  shortName?: string;
  /**
   * Password for the directory administrator account (`Administrator` for
   * Simple AD, `Admin` for Microsoft AD). There is no API to change it after
   * creation, so changing the password replaces the directory.
   */
  password: Redacted.Redacted<string>;
  /**
   * Human-readable description of the directory. There is no update API, so
   * changing the description replaces the directory.
   */
  description?: string;
  /**
   * Size of a Simple AD directory — `"Small"` (up to ~500 users) or
   * `"Large"` (up to ~5000 users). Ignored for Microsoft AD. Changing the
   * size replaces the directory.
   * @default "Small"
   */
  size?: ds.DirectorySize;
  /**
   * Edition of a Microsoft AD directory — `"Standard"` or `"Enterprise"`.
   * Ignored for Simple AD. Changing the edition replaces the directory.
   * @default "Standard"
   */
  edition?: ds.DirectoryEdition;
  /**
   * VPC the directory's domain controllers are placed into. Changing the
   * VPC replaces the directory.
   */
  vpcId: string;
  /**
   * Exactly two subnets in DIFFERENT Availability Zones of `vpcId` — one
   * domain controller is launched into each. Changing the subnets replaces
   * the directory.
   */
  subnetIds: string[];
  /**
   * User-defined tags for the directory.
   */
  tags?: Record<string, string>;
}

export interface Directory extends Resource<
  "AWS.DirectoryService.Directory",
  DirectoryProps,
  {
    /** The ID of the directory, e.g. `d-1234567890`. */
    directoryId: string;
    /** The ARN of the directory, e.g. `arn:aws:ds:us-east-1:123456789012:directory/d-1234567890`. */
    directoryArn: string;
    /** The fully qualified name of the directory. */
    directoryName: string;
    /** The directory type, e.g. `SimpleAD` or `MicrosoftAD`. */
    type: string;
    /** The current lifecycle stage of the directory, e.g. `Active`. */
    stage: string;
    /** The size of a Simple AD directory (`Small` or `Large`). */
    size: string | undefined;
    /** The edition of a Microsoft AD directory (`Standard` or `Enterprise`). */
    edition: string | undefined;
    /** The directory alias used for the access URL. */
    alias: string | undefined;
    /** The access URL of the directory, e.g. `<alias>.awsapps.com`. */
    accessUrl: string | undefined;
    /** The IP addresses of the directory's DNS servers. */
    dnsIpAddrs: string[];
    /** The security group created for the directory's controllers. */
    securityGroupId: string | undefined;
    /** The VPC the directory is deployed into. */
    vpcId: string | undefined;
    /** The subnets hosting the directory's domain controllers. */
    subnetIds: string[];
    /** The Availability Zones the directory spans. */
    availabilityZones: string[];
    /** The tags attached to the directory. */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An AWS Directory Service managed directory — either Simple AD (Samba) or
 * AWS Managed Microsoft AD.
 *
 * Directories are VPC-only and require two subnets in different Availability
 * Zones. Provisioning is SLOW: Simple AD takes roughly 10 minutes and
 * Microsoft AD 20-40 minutes, and directories bill hourly while they exist.
 * Destroy directories you are not using.
 * @resource
 * @section Creating a Directory
 * @example Simple AD Directory
 * ```typescript
 * const directory = yield* Directory("Corp", {
 *   name: "corp.example.com",
 *   password: Redacted.make("SuperSecret123!"),
 *   size: "Small",
 *   vpcId: vpc.vpcId,
 *   subnetIds: [subnetA.subnetId, subnetB.subnetId],
 * });
 * ```
 *
 * @example Managed Microsoft AD Directory
 * ```typescript
 * const directory = yield* Directory("Corp", {
 *   type: "MicrosoftAD",
 *   name: "corp.example.com",
 *   shortName: "CORP",
 *   password: Redacted.make("SuperSecret123!"),
 *   edition: "Standard",
 *   vpcId: vpc.vpcId,
 *   subnetIds: [subnetA.subnetId, subnetB.subnetId],
 * });
 * ```
 *
 * @section Using the Directory
 * @example Read the DNS Addresses
 * ```typescript
 * const directory = yield* Directory("Corp", { ... });
 * // the directory-provided DNS servers, one per Availability Zone
 * const dns = directory.dnsIpAddrs;
 * ```
 */
export const Directory = Resource<Directory>("AWS.DirectoryService.Directory");

const DEFAULT_SIZE: ds.DirectorySize = "Small";
const DEFAULT_EDITION: ds.DirectoryEdition = "Standard";

/** Stages from which a directory can never come back. */
const isTerminalStage = (stage: string | undefined): boolean =>
  stage === "Deleting" || stage === "Deleted" || stage === "Failed";

class DirectoryNotReady extends Data.TaggedError("DirectoryNotReady")<{
  readonly directoryId: string;
  readonly stage: string | undefined;
}> {}

class DirectoryProvisioningFailed extends Data.TaggedError(
  "DirectoryProvisioningFailed",
)<{
  readonly directoryId: string;
  readonly stage: string | undefined;
  readonly reason: string | undefined;
}> {}

// Directory provisioning is slow (Simple AD ~10 min, Microsoft AD 20-40
// min); poll every 30s with a ~50 min budget. Only DirectoryNotReady is
// retried — a Failed/Deleted stage aborts immediately.
const retryWhileNotReady = <A, E extends { readonly _tag: string }, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) => e._tag === "DirectoryNotReady",
    schedule: Schedule.max([
      Schedule.fixed("30 seconds"),
      Schedule.recurs(100),
    ]),
  });

export const DirectoryProvider = () =>
  Provider.effect(
    Directory,
    Effect.gen(function* () {
      const getById = Effect.fn(function* (directoryId: string) {
        const response = yield* ds
          .describeDirectories({ DirectoryIds: [directoryId] })
          .pipe(
            Effect.catchTag("EntityDoesNotExistException", () =>
              Effect.succeed(undefined),
            ),
          );
        return response?.DirectoryDescriptions?.[0];
      });

      // Best-effort fallback for lost state: scan the account's directories
      // for a live one with the desired domain name.
      const findByName = Effect.fn(function* (name: string | undefined) {
        if (name === undefined) return undefined;
        const matches = yield* ds.describeDirectories.items({}).pipe(
          Stream.filter((d) => d.Name === name && !isTerminalStage(d.Stage)),
          Stream.take(1),
          Stream.runCollect,
        );
        return Array.from(matches)[0];
      });

      const observe = Effect.fn(function* (
        directoryId: string | undefined,
        name: string | undefined,
      ) {
        const found = directoryId
          ? yield* getById(directoryId)
          : yield* findByName(name);
        return found !== undefined && !isTerminalStage(found.Stage)
          ? found
          : undefined;
      });

      const waitForActive = (directoryId: string) =>
        Effect.gen(function* () {
          const directory = yield* getById(directoryId);
          if (directory === undefined || isTerminalStage(directory.Stage)) {
            return yield* new DirectoryProvisioningFailed({
              directoryId,
              stage: directory?.Stage,
              reason: directory?.StageReason,
            });
          }
          if (directory.Stage !== "Active") {
            return yield* new DirectoryNotReady({
              directoryId,
              stage: directory.Stage,
            });
          }
          return directory;
        }).pipe(retryWhileNotReady);

      // Wait for a directory to leave a transitional stage before deleting.
      // Ends when the directory is in a steady stage, already deleting, or
      // gone.
      const waitUntilSettled = Effect.fn(function* (directoryId: string) {
        return yield* getById(directoryId).pipe(
          Effect.flatMap((directory) => {
            if (
              directory !== undefined &&
              (directory.Stage === "Requested" ||
                directory.Stage === "Creating" ||
                directory.Stage === "Created" ||
                directory.Stage === "Restoring" ||
                directory.Stage === "Updating")
            ) {
              return Effect.fail(
                new DirectoryNotReady({
                  directoryId,
                  stage: directory.Stage,
                }),
              );
            }
            return Effect.succeed(directory);
          }),
          retryWhileNotReady,
        );
      });

      const toAttrs = Effect.fn(function* (directory: ds.DirectoryDescription) {
        if (!directory.DirectoryId || !directory.Name) {
          return yield* Effect.fail(
            new Error(
              `directory '${directory.DirectoryId}' is missing its id or name`,
            ),
          );
        }
        const { accountId, region } = yield* AWSEnvironment.current;
        return {
          directoryId: directory.DirectoryId,
          directoryArn: `arn:aws:ds:${region}:${accountId}:directory/${directory.DirectoryId}`,
          directoryName: directory.Name,
          type: directory.Type ?? "SimpleAD",
          stage: directory.Stage ?? "Active",
          size: directory.Size,
          edition: directory.Edition,
          alias: directory.Alias,
          accessUrl: directory.AccessUrl,
          dnsIpAddrs: [...(directory.DnsIpAddrs ?? [])],
          securityGroupId: directory.VpcSettings?.SecurityGroupId,
          vpcId: directory.VpcSettings?.VpcId,
          subnetIds: [...(directory.VpcSettings?.SubnetIds ?? [])],
          availabilityZones: [
            ...(directory.VpcSettings?.AvailabilityZones ?? []),
          ],
          tags: yield* readDirectoryTags(directory.DirectoryId),
        };
      });

      return {
        stables: ["directoryId", "directoryName"],

        diff: Effect.fn(function* ({ olds, news }) {
          if (!isResolved(news)) return undefined;
          const n = news;
          const o = olds;
          if (o === undefined || n === undefined) return undefined;
          // Every launch property is create-only — there is no update API
          // for the directory itself; only tags mutate in place.
          const type = (p: DirectoryProps) => p.type ?? "SimpleAD";
          if (type(n) !== type(o)) return { action: "replace" } as const;
          if (n.name !== o.name) return { action: "replace" } as const;
          if (n.shortName !== o.shortName) {
            return { action: "replace" } as const;
          }
          if (Redacted.value(n.password) !== Redacted.value(o.password)) {
            return { action: "replace" } as const;
          }
          if (n.description !== o.description) {
            return { action: "replace" } as const;
          }
          if (
            type(n) === "SimpleAD" &&
            (n.size ?? DEFAULT_SIZE) !== (o.size ?? DEFAULT_SIZE)
          ) {
            return { action: "replace" } as const;
          }
          if (
            type(n) === "MicrosoftAD" &&
            (n.edition ?? DEFAULT_EDITION) !== (o.edition ?? DEFAULT_EDITION)
          ) {
            return { action: "replace" } as const;
          }
          if (n.vpcId !== o.vpcId) return { action: "replace" } as const;
          if (!sameStringSet(n.subnetIds, o.subnetIds)) {
            return { action: "replace" } as const;
          }
        }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const directory = yield* observe(output?.directoryId, olds?.name);
          if (directory === undefined) return undefined;
          const attrs = yield* toAttrs(directory);
          return (yield* hasAlchemyTags(id, attrs.tags))
            ? attrs
            : Unowned(attrs);
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const props = news!;
          const type = props.type ?? "SimpleAD";
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...props.tags };

          // 1. Observe — cloud state is authoritative; output only caches
          //    the directory id.
          const observed = yield* observe(output?.directoryId, props.name);

          // 2. Ensure — create if missing.
          let directoryId = observed?.DirectoryId;
          if (directoryId === undefined) {
            const tagList = Object.entries(desiredTags).map(([Key, Value]) => ({
              Key,
              Value,
            }));
            const created =
              type === "MicrosoftAD"
                ? yield* ds.createMicrosoftAD({
                    Name: props.name,
                    ShortName: props.shortName,
                    Password: props.password,
                    Description: props.description,
                    Edition: props.edition ?? DEFAULT_EDITION,
                    VpcSettings: {
                      VpcId: props.vpcId,
                      SubnetIds: props.subnetIds,
                    },
                    Tags: tagList,
                  })
                : yield* ds.createDirectory({
                    Name: props.name,
                    ShortName: props.shortName,
                    Password: props.password,
                    Description: props.description,
                    Size: props.size ?? DEFAULT_SIZE,
                    VpcSettings: {
                      VpcId: props.vpcId,
                      SubnetIds: props.subnetIds,
                    },
                    Tags: tagList,
                  });
            if (created.DirectoryId === undefined) {
              return yield* Effect.fail(
                new Error(
                  `Create${type} for '${props.name}' returned no DirectoryId`,
                ),
              );
            }
            directoryId = created.DirectoryId;
          }

          // Provisioning is slow (Simple AD ~10 min, Microsoft AD 20-40
          // min); wait (bounded) for the directory to become Active so the
          // returned attributes (DNS addresses, security group) are real.
          const active = yield* waitForActive(directoryId);

          // 3. Sync tags — diff against OBSERVED cloud tags.
          const observedTags = yield* readDirectoryTags(directoryId);
          const { upsert, removed } = diffTags(observedTags, desiredTags);
          if (upsert.length > 0) {
            yield* ds.addTagsToResource({
              ResourceId: directoryId,
              Tags: upsert,
            });
          }
          if (removed.length > 0) {
            yield* ds.removeTagsFromResource({
              ResourceId: directoryId,
              TagKeys: removed,
            });
          }

          yield* session.note(directoryId);
          return yield* toAttrs(active);
        }),

        delete: Effect.fn(function* ({ output }) {
          const directoryId = output.directoryId;
          // A directory mid-create rejects deletion — wait (bounded) for it
          // to settle first. Already deleting (or gone) is success.
          const settled = yield* waitUntilSettled(directoryId).pipe(
            Effect.catch(() => Effect.succeed(undefined)),
          );
          if (
            settled === undefined ||
            settled.Stage === "Deleting" ||
            settled.Stage === "Deleted"
          ) {
            return;
          }
          yield* ds
            .deleteDirectory({ DirectoryId: directoryId })
            .pipe(
              Effect.catchTag("EntityDoesNotExistException", () => Effect.void),
            );
        }),

        list: () =>
          ds.describeDirectories.items({}).pipe(
            Stream.runCollect,
            Effect.flatMap((directories) =>
              Effect.forEach(
                Array.from(directories).filter(
                  (d) =>
                    d.DirectoryId !== undefined &&
                    d.Name !== undefined &&
                    !isTerminalStage(d.Stage),
                ),
                (d) => toAttrs(d),
                { concurrency: 4 },
              ),
            ),
          ),
      };
    }),
  );
