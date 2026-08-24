import * as repostspace from "@distilled.cloud/aws/repostspace";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, diffTags, hasAlchemyTags } from "../../Tags.ts";
import type { Providers } from "../Providers.ts";

/** Unwrap a distilled sensitive value into its plain string. */
const unwrapSensitive = (
  value: string | Redacted.Redacted<string> | undefined,
): string | undefined =>
  value === undefined
    ? undefined
    : Redacted.isRedacted(value)
      ? Redacted.value(value)
      : value;

export interface SpaceSupportedEmailDomains {
  /**
   * Whether the supported-email-domains feature is enabled for the
   * private re:Post.
   */
  enabled?: "ENABLED" | "DISABLED";
  /**
   * Email domains allowed to join the private re:Post.
   */
  allowedDomains?: string[];
}

export interface SpaceProps {
  /**
   * Display name of the private re:Post. Must be unique within the account.
   * Changing the name replaces the space.
   * @default a deterministic physical name derived from app, stage, and id
   */
  name?: string;
  /**
   * Subdomain the private re:Post is served from
   * (`https://{subdomain}-{random}.private.repost.aws`). Must be globally
   * unique across AWS re:Post Private. Changing the subdomain replaces the
   * space.
   * @default a deterministic lowercase physical name derived from app, stage, and id
   */
  subdomain?: string;
  /**
   * Pricing tier of the private re:Post — `"BASIC"` or `"STANDARD"`.
   * Updated in place.
   * @default "BASIC"
   */
  tier?: repostspace.TierLevel;
  /**
   * Human-readable description of the private re:Post.
   */
  description?: string;
  /**
   * ARN of a customer-managed KMS key used to encrypt the space's data.
   * Changing the key replaces the space.
   * @default an AWS-owned key
   */
  userKMSKey?: string;
  /**
   * ARN of the IAM role that grants AWS re:Post Private access to
   * resources in your account (e.g. for IAM Identity Center integration).
   */
  roleArn?: string;
  /**
   * Email domains allowed to join the private re:Post without an explicit
   * invite.
   */
  supportedEmailDomains?: SpaceSupportedEmailDomains;
  /**
   * User-defined tags for the space. Merged with internal Alchemy tags.
   */
  tags?: Record<string, string>;
}

export interface Space extends Resource<
  "AWS.RePostSpace.Space",
  SpaceProps,
  {
    /**
     * Unique ID of the private re:Post space.
     */
    spaceId: string;
    /**
     * ARN of the space.
     */
    spaceArn: string;
    /**
     * Display name of the space.
     */
    name: string;
    /**
     * Current space status (e.g. `"CREATE_COMPLETED"`).
     */
    status: string;
    /**
     * IAM Identity Center configuration status of the space
     * (e.g. `"CONFIGURED"` / `"UNCONFIGURED"`).
     */
    configurationStatus: string;
    /**
     * Client ID of the space's IAM Identity Center application.
     */
    clientId: string;
    /**
     * ID of the IAM Identity Center identity store backing the space.
     */
    identityStoreId: string | undefined;
    /**
     * ARN of the space's IAM Identity Center application.
     */
    applicationArn: string | undefined;
    /**
     * Description of the space.
     */
    description: string | undefined;
    /**
     * Subdomain the space is served from.
     */
    vanityDomain: string;
    /**
     * Approval status of the vanity domain (e.g. `"PENDING"`, `"APPROVED"`).
     */
    vanityDomainStatus: string;
    /**
     * AWS-generated domain the space is reachable on.
     */
    randomDomain: string;
    /**
     * ARN of the customer-provided IAM role the space uses for account
     * integrations (mirrors the `roleArn` prop).
     */
    customerRoleArn: string | undefined;
    /**
     * Pricing tier of the space (`"BASIC"` or `"STANDARD"`).
     */
    tier: string;
    /**
     * Storage limit of the space, in bytes.
     */
    storageLimit: number;
    /**
     * Customer-managed KMS key encrypting the space's data, if any.
     */
    userKMSKey: string | undefined;
    /**
     * Tags on the space (including internal Alchemy tags).
     */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An AWS re:Post Private space — a private, organization-scoped version of
 * AWS re:Post with curated Q&A, articles, and selected public content.
 *
 * re:Post Private is a paid feature (Basic or Standard tier) that requires
 * AWS IAM Identity Center to be enabled in the account. Space provisioning
 * is asynchronous and can take tens of minutes; the provider waits for the
 * space to reach `CREATE_COMPLETED` before returning.
 * @resource
 * @section Creating a Space
 * @example Basic Space
 * ```typescript
 * import * as RePostSpace from "alchemy/AWS/RePostSpace";
 *
 * const space = yield* RePostSpace.Space("Support", {
 *   subdomain: "my-org-support",
 *   tier: "BASIC",
 * });
 * ```
 *
 * @example Space with Description and Tags
 * ```typescript
 * const space = yield* RePostSpace.Space("Engineering", {
 *   name: "Engineering Knowledge Base",
 *   subdomain: "my-org-engineering",
 *   tier: "STANDARD",
 *   description: "Internal Q&A for the engineering org",
 *   tags: { team: "platform" },
 * });
 * ```
 *
 * @section Encryption
 * @example Space with a Customer-Managed KMS Key
 * ```typescript
 * const space = yield* RePostSpace.Space("Secure", {
 *   subdomain: "my-org-secure",
 *   userKMSKey: key.keyArn,
 * });
 * ```
 */
export const Space = Resource<Space>("AWS.RePostSpace.Space");

const DEFAULT_TIER = "BASIC";

/**
 * Raised when a re:Post Private space enters a terminal failure state
 * (`CREATE_FAILED`) or starts deleting while the provider is waiting for
 * provisioning to complete.
 */
export class RePostSpaceProvisioningFailed extends Data.TaggedError(
  "RePostSpaceProvisioningFailed",
)<{ spaceId: string; status: string }> {}

/** Internal marker error driving the bounded readiness retry loop. */
class RePostSpaceNotReady extends Data.TaggedError("RePostSpaceNotReady")<{
  spaceId: string;
  status: string;
}> {}

const sameStringSet = (
  a: readonly string[] | undefined,
  b: readonly string[] | undefined,
): boolean => {
  const left = [...new Set(a ?? [])].sort();
  const right = [...new Set(b ?? [])].sort();
  return left.length === right.length && left.every((v, i) => v === right[i]);
};

export const SpaceProvider = () =>
  Provider.effect(
    Space,
    Effect.gen(function* () {
      const toName = (id: string, props: Partial<SpaceProps>) =>
        props.name
          ? Effect.succeed(props.name)
          : createPhysicalName({ id, maxLength: 30 });

      const toSubdomain = (id: string, props: Partial<SpaceProps>) =>
        props.subdomain
          ? Effect.succeed(props.subdomain)
          : createPhysicalName({ id, maxLength: 63, lowercase: true });

      const getSpaceOrUndefined = Effect.fn(function* (spaceId: string) {
        return yield* repostspace
          .getSpace({ spaceId })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
      });

      // Locate a live (not deleting/deleted) space by display name. Space
      // IDs are auto-assigned, so this is the fallback when the state
      // output cache is absent (e.g. after a past persistence failure).
      const findByName = Effect.fn(function* (name: string) {
        const chunk = yield* repostspace.listSpaces
          .items({})
          .pipe(Stream.runCollect);
        return Array.from(chunk).find(
          (space) =>
            unwrapSensitive(space.name) === name &&
            !space.status.startsWith("DELETE"),
        );
      });

      const readSpaceTags = Effect.fn(function* (arn: string) {
        const response = yield* repostspace
          .listTagsForResource({ resourceArn: arn })
          .pipe(Effect.catch(() => Effect.succeed(undefined)));
        const tags: Record<string, string> = {};
        for (const [key, value] of Object.entries(response?.tags ?? {})) {
          if (value !== undefined) tags[key] = value;
        }
        return tags;
      });

      // Explicitly-typed pipeable retry helper. Inlining `Effect.retry` in a
      // provider lifecycle op leaks `Retry.Return`'s conditional into
      // declaration emit and widens the provider layer to `unknown` R for
      // every consumer of `AWS.providers()`.
      const retryWhileSpaceNotReady = <
        A,
        E extends { readonly _tag: string },
        R,
      >(
        self: Effect.Effect<A, E, R>,
      ): Effect.Effect<A, E, R> =>
        Effect.retry(self, {
          while: (e) => e._tag === "RePostSpaceNotReady",
          schedule: Schedule.max([
            Schedule.fixed("30 seconds"),
            Schedule.recurs(80),
          ]),
        });

      // Bounded readiness wait. Space provisioning is asynchronous and can
      // take ~30 minutes; budget 40 min (80 * 30s). CREATE_FAILED and any
      // DELETE* status are terminal failures and stop the retry loop.
      const waitForCreated = Effect.fn(function* (spaceId: string) {
        return yield* retryWhileSpaceNotReady(
          Effect.gen(function* () {
            const space = yield* repostspace.getSpace({ spaceId });
            if (
              space.status === "CREATE_FAILED" ||
              space.status.startsWith("DELETE")
            ) {
              return yield* Effect.fail(
                new RePostSpaceProvisioningFailed({
                  spaceId,
                  status: space.status,
                }),
              );
            }
            if (space.status !== "CREATE_COMPLETED") {
              return yield* Effect.fail(
                new RePostSpaceNotReady({ spaceId, status: space.status }),
              );
            }
            return space;
          }),
        );
      });

      const toAttrs = Effect.fn(function* (space: repostspace.GetSpaceOutput) {
        return {
          spaceId: space.spaceId,
          spaceArn: space.arn,
          name: unwrapSensitive(space.name) ?? "",
          status: space.status,
          configurationStatus: space.configurationStatus,
          clientId: space.clientId,
          identityStoreId: space.identityStoreId,
          applicationArn: space.applicationArn,
          description: unwrapSensitive(space.description),
          vanityDomain: space.vanityDomain,
          vanityDomainStatus: space.vanityDomainStatus,
          randomDomain: space.randomDomain,
          customerRoleArn: space.customerRoleArn,
          tier: space.tier,
          storageLimit: space.storageLimit,
          userKMSKey: space.userKMSKey,
          tags: yield* readSpaceTags(space.arn),
        };
      });

      return Space.Provider.of({
        stables: ["spaceId", "spaceArn", "clientId"],

        list: () =>
          Effect.gen(function* () {
            const chunk = yield* repostspace.listSpaces
              .items({})
              .pipe(Stream.runCollect);
            const items = yield* Effect.forEach(
              Array.from(chunk),
              (space) =>
                repostspace.getSpace({ spaceId: space.spaceId }).pipe(
                  Effect.flatMap((full) => toAttrs(full)),
                  // A space can vanish between enumeration and hydration.
                  Effect.catchTag("ResourceNotFoundException", () =>
                    Effect.succeed(undefined),
                  ),
                ),
              { concurrency: 4 },
            );
            return items.filter(
              (item): item is Space["Attributes"] => item !== undefined,
            );
          }),

        read: Effect.fn(function* ({ id, olds, output }) {
          let spaceId = output?.spaceId;
          if (spaceId === undefined) {
            const name = yield* toName(id, olds ?? {});
            const found = yield* findByName(name);
            spaceId = found?.spaceId;
          }
          if (spaceId === undefined) return undefined;
          const space = yield* getSpaceOrUndefined(spaceId);
          if (space === undefined || space.status.startsWith("DELETE")) {
            return undefined;
          }
          const attrs = yield* toAttrs(space);
          return (yield* hasAlchemyTags(id, attrs.tags))
            ? attrs
            : Unowned(attrs);
        }),

        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return undefined;
          const n = news ?? {};
          const o = olds ?? {};
          // Create-only properties force a replacement.
          if ((yield* toName(id, o)) !== (yield* toName(id, n))) {
            return { action: "replace" } as const;
          }
          if ((yield* toSubdomain(id, o)) !== (yield* toSubdomain(id, n))) {
            return { action: "replace" } as const;
          }
          if (n.userKMSKey !== o.userKMSKey) {
            return { action: "replace" } as const;
          }
          // tier, description, roleArn, supportedEmailDomains update in place.
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const props = news ?? {};
          const name = output?.name ?? (yield* toName(id, props));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...props.tags };
          const desiredTier = props.tier ?? DEFAULT_TIER;

          // 1. Observe — cloud state is authoritative; output is only an
          //    id cache. Fall through to a by-name lookup when the cached
          //    space no longer exists.
          let spaceId = output?.spaceId;
          if (spaceId !== undefined) {
            const cached = yield* getSpaceOrUndefined(spaceId);
            if (cached === undefined || cached.status.startsWith("DELETE")) {
              spaceId = undefined;
            }
          }
          if (spaceId === undefined) {
            const found = yield* findByName(name);
            spaceId = found?.spaceId;
          }

          // 2. Ensure — create if missing; a ConflictException means a peer
          //    created it concurrently (or the name/subdomain is taken), so
          //    fall back to the by-name lookup.
          if (spaceId === undefined) {
            const subdomain = yield* toSubdomain(id, props);
            spaceId = yield* repostspace
              .createSpace({
                name,
                subdomain,
                tier: desiredTier,
                description: props.description,
                userKMSKey: props.userKMSKey,
                roleArn: props.roleArn,
                supportedEmailDomains: props.supportedEmailDomains,
                tags: desiredTags,
              })
              .pipe(
                Effect.map((r) => r.spaceId),
                Effect.catchTag("ConflictException", (error) =>
                  findByName(name).pipe(
                    Effect.flatMap((existing) =>
                      existing !== undefined
                        ? Effect.succeed(existing.spaceId)
                        : Effect.fail(error),
                    ),
                  ),
                ),
              );
            yield* session.note(`created space ${spaceId}, provisioning...`);
          }

          // Provisioning is asynchronous — wait (bounded) for the space to
          // become usable before syncing mutable aspects.
          let observed = yield* waitForCreated(spaceId);

          // 3. Sync — compute the update delta from OBSERVED state and call
          //    updateSpace only when something actually changed.
          const update: {
            description?: string;
            tier?: repostspace.TierLevel;
            roleArn?: string;
            supportedEmailDomains?: repostspace.SupportedEmailDomainsParameters;
          } = {};
          let mutated = false;
          if (
            props.description !== undefined &&
            props.description !== unwrapSensitive(observed.description)
          ) {
            update.description = props.description;
            mutated = true;
          }
          if (props.tier !== undefined && props.tier !== observed.tier) {
            update.tier = props.tier;
            mutated = true;
          }
          if (
            props.roleArn !== undefined &&
            props.roleArn !== observed.customerRoleArn
          ) {
            update.roleArn = props.roleArn;
            mutated = true;
          }
          if (props.supportedEmailDomains !== undefined) {
            const observedDomains = (
              observed.supportedEmailDomains?.allowedDomains ?? []
            ).map(
              (domain: string | Redacted.Redacted<string>) =>
                unwrapSensitive(domain) ?? "",
            );
            if (
              props.supportedEmailDomains.enabled !==
                observed.supportedEmailDomains?.enabled ||
              !sameStringSet(
                props.supportedEmailDomains.allowedDomains,
                observedDomains,
              )
            ) {
              update.supportedEmailDomains = props.supportedEmailDomains;
              mutated = true;
            }
          }
          if (mutated) {
            yield* repostspace.updateSpace({ spaceId, ...update });
            const refreshed = yield* getSpaceOrUndefined(spaceId);
            if (refreshed !== undefined) observed = refreshed;
          }

          // 3b. Sync tags — diff against OBSERVED cloud tags so adoption
          //     converges.
          const observedTags = yield* readSpaceTags(observed.arn);
          const { removed, upsert } = diffTags(observedTags, desiredTags);
          if (upsert.length > 0) {
            yield* repostspace.tagResource({
              resourceArn: observed.arn,
              tags: Object.fromEntries(upsert.map((t) => [t.Key, t.Value])),
            });
          }
          if (removed.length > 0) {
            yield* repostspace.untagResource({
              resourceArn: observed.arn,
              tagKeys: removed,
            });
          }

          yield* session.note(spaceId);
          return yield* toAttrs(observed);
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* repostspace
            .deleteSpace({ spaceId: output.spaceId })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
        }),
      });
    }),
  );
