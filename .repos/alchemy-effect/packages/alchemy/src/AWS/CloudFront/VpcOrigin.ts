import * as cloudfront from "@distilled.cloud/aws/cloudfront";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, createTagsList, diffTags } from "../../Tags.ts";
import type { Providers } from "../Providers.ts";

class VpcOriginPendingDeployment extends Data.TaggedError(
  "VpcOriginPendingDeployment",
)<{
  message: string;
}> {}

class VpcOriginStillInUse extends Data.TaggedError("VpcOriginStillInUse")<{
  message: string;
}> {}

export interface VpcOriginProps {
  /**
   * Name of the VPC origin. If omitted, a deterministic name is generated.
   */
  name?: string;
  /**
   * ARN of the resource the VPC origin fronts (an Application/Network Load
   * Balancer or an EC2 instance in a VPC). Changing the target ARN forces a
   * replacement.
   */
  arn: string;
  /**
   * HTTP port CloudFront uses to connect to the origin.
   * @default 80
   */
  httpPort?: number;
  /**
   * HTTPS port CloudFront uses to connect to the origin.
   * @default 443
   */
  httpsPort?: number;
  /**
   * Origin protocol policy CloudFront uses to connect to the origin.
   * @default "https-only"
   */
  originProtocolPolicy?: cloudfront.OriginProtocolPolicy;
  /**
   * SSL/TLS protocols CloudFront uses when establishing an HTTPS connection.
   * @default ["TLSv1.2"]
   */
  originSslProtocols?: cloudfront.SslProtocol[];
  /**
   * User-defined tags to apply to the VPC origin.
   */
  tags?: Record<string, string>;
}

export interface VpcOrigin extends Resource<
  "AWS.CloudFront.VpcOrigin",
  VpcOriginProps,
  {
    /**
     * CloudFront-assigned VPC origin identifier.
     */
    vpcOriginId: string;
    /**
     * ARN of the VPC origin.
     */
    vpcOriginArn: string;
    /**
     * Current deployment status of the VPC origin.
     */
    status: string;
    /**
     * Name of the VPC origin.
     */
    name: string;
    /**
     * ARN of the resource the VPC origin fronts.
     */
    arn: string;
    /**
     * Creation timestamp.
     */
    createdTime: Date | undefined;
    /**
     * Last CloudFront modification timestamp.
     */
    lastModifiedTime: Date | undefined;
    /**
     * Most recent entity tag for update/delete operations.
     */
    etag: string | undefined;
    /**
     * Current tags on the VPC origin.
     */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A CloudFront VPC origin.
 *
 * `VpcOrigin` lets a CloudFront distribution route to a private Application
 * Load Balancer, Network Load Balancer, or EC2 instance inside a VPC without
 * exposing it to the public internet. Reference the resulting `vpcOriginId`
 * from a distribution origin's `vpcOriginConfig`.
 * @resource
 * @section Creating VPC Origins
 * @example Private ALB Origin
 * ```typescript
 * const vpcOrigin = yield* VpcOrigin("AppOrigin", {
 *   arn: loadBalancer.arn,
 *   httpPort: 80,
 *   httpsPort: 443,
 *   originProtocolPolicy: "https-only",
 * });
 * ```
 *
 * @example Attaching a VPC Origin to a Distribution
 * ```typescript
 * const distribution = yield* Distribution("AppCdn", {
 *   origins: [
 *     {
 *       id: "app",
 *       domainName: loadBalancer.dnsName,
 *       vpcOriginConfig: { vpcOriginId: vpcOrigin.vpcOriginId },
 *     },
 *   ],
 *   defaultCacheBehavior: {
 *     targetOriginId: "app",
 *     viewerProtocolPolicy: "redirect-to-https",
 *   },
 * });
 * ```
 */
export const VpcOrigin = Resource<VpcOrigin>("AWS.CloudFront.VpcOrigin");

export const VpcOriginProvider = () =>
  Provider.effect(
    VpcOrigin,
    Effect.gen(function* () {
      // Observe — locate the VPC origin by id, tolerating a concurrent delete.
      const getById = Effect.fn(function* (id: string) {
        const result = yield* cloudfront
          .getVpcOrigin({ Id: id })
          .pipe(
            Effect.catchTag("EntityNotFound", () => Effect.succeed(undefined)),
          );
        if (!result?.VpcOrigin?.Id) {
          return undefined;
        }
        return { vpcOrigin: result.VpcOrigin, etag: result.ETag };
      });

      // Crash recovery — a create can succeed in the cloud but fail to persist
      // locally. Recover by listing and matching on the fronted ARN.
      const getByArn = Effect.fn(function* (arn: string) {
        let marker: string | undefined;
        do {
          const listed: cloudfront.ListVpcOriginsResult =
            yield* cloudfront.listVpcOrigins({ Marker: marker });
          const summary = listed.VpcOriginList?.Items?.find(
            (item) => item.OriginEndpointArn === arn,
          );
          if (summary?.Id) {
            return yield* getById(summary.Id);
          }
          marker = listed.VpcOriginList?.IsTruncated
            ? listed.VpcOriginList.NextMarker
            : undefined;
        } while (marker);
        return undefined;
      });

      const fetchTags = Effect.fn(function* (arn: string) {
        const response = yield* cloudfront.listTagsForResource({
          Resource: arn,
        });
        return toTagsRecord(response.Tags.Items);
      });

      // Wait — poll until the VPC origin reaches the terminal `Deployed` state,
      // mirroring the Distribution deployment wait.
      const waitForDeployment = Effect.fn(function* (id: string) {
        return yield* getById(id).pipe(
          Effect.flatMap((current) =>
            current?.vpcOrigin.Status === "Deployed"
              ? Effect.succeed(current)
              : Effect.fail(
                  new VpcOriginPendingDeployment({
                    message: `VPC origin ${id} is not yet deployed (status=${current?.vpcOrigin.Status ?? "unknown"})`,
                  }),
                ),
          ),
          Effect.retry({
            while: (error) => error._tag === "VpcOriginPendingDeployment",
            // CloudFront VPC-origin deployment is slow (global propagation) and
            // routinely exceeds 10 min; budget ~20 min (120 * 10s) so a real
            // deploy doesn't fail spuriously.
            schedule: Schedule.max([
              Schedule.fixed("10 seconds"),
              Schedule.recurs(120),
            ]),
          }),
        );
      });

      const desiredEndpointConfig = (
        name: string,
        props: VpcOriginProps,
      ): cloudfront.VpcOriginEndpointConfig => ({
        Name: name,
        Arn: props.arn,
        HTTPPort: props.httpPort ?? 80,
        HTTPSPort: props.httpsPort ?? 443,
        OriginProtocolPolicy: props.originProtocolPolicy ?? "https-only",
        OriginSslProtocols: {
          Quantity: (props.originSslProtocols ?? ["TLSv1.2"]).length,
          Items: props.originSslProtocols ?? ["TLSv1.2"],
        },
      });

      const endpointConfigEquals = (
        a: cloudfront.VpcOriginEndpointConfig | undefined,
        b: cloudfront.VpcOriginEndpointConfig,
      ) =>
        !!a &&
        a.Name === b.Name &&
        a.Arn === b.Arn &&
        a.HTTPPort === b.HTTPPort &&
        a.HTTPSPort === b.HTTPSPort &&
        a.OriginProtocolPolicy === b.OriginProtocolPolicy &&
        (a.OriginSslProtocols?.Items ?? []).join(",") ===
          (b.OriginSslProtocols?.Items ?? []).join(",");

      const syncTags = Effect.fn(function* (
        arn: string,
        observedTags: Record<string, string>,
        desiredTags: Record<string, string>,
      ) {
        const { removed, upsert } = diffTags(observedTags, desiredTags);
        if (upsert.length > 0) {
          yield* cloudfront.tagResource({
            Resource: arn,
            Tags: { Items: upsert },
          });
        }
        if (removed.length > 0) {
          yield* cloudfront.untagResource({
            Resource: arn,
            TagKeys: { Items: removed },
          });
        }
      });

      return {
        stables: ["vpcOriginId", "vpcOriginArn"],
        list: () =>
          Effect.gen(function* () {
            const items: VpcOrigin["Attributes"][] = [];
            let marker: string | undefined;
            do {
              const listed: cloudfront.ListVpcOriginsResult =
                yield* cloudfront.listVpcOrigins({ Marker: marker });
              for (const summary of listed.VpcOriginList?.Items ?? []) {
                if (!summary.Id) continue;
                const current = yield* getById(summary.Id);
                if (!current) continue;
                const tags = yield* fetchTags(current.vpcOrigin.Arn);
                items.push(toAttrs(current.vpcOrigin, current.etag, tags));
              }
              marker = listed.VpcOriginList?.IsTruncated
                ? listed.VpcOriginList.NextMarker
                : undefined;
            } while (marker);
            return items;
          }),
        diff: Effect.fn(function* ({ id, olds, news: _news }) {
          if (!isResolved(_news)) return undefined;
          const news = _news as VpcOriginProps;
          // `arn` is create-only — a changed target endpoint forces replace.
          if (olds?.arn !== undefined && olds.arn !== news.arn) {
            return { action: "replace" } as const;
          }
          // A changed name also forces replace (it is the immutable identity).
          if (
            (yield* createName(id, olds ?? ({} as VpcOriginProps))) !==
            (yield* createName(id, news))
          ) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const existing = output?.vpcOriginId
            ? yield* getById(output.vpcOriginId)
            : yield* getByArn((olds ?? ({} as VpcOriginProps)).arn ?? "");
          if (!existing?.vpcOrigin.Id) {
            return undefined;
          }
          const tags = yield* fetchTags(existing.vpcOrigin.Arn);
          return toAttrs(existing.vpcOrigin, existing.etag, tags);
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = yield* createName(id, news);
          const desiredTags = {
            ...(yield* createInternalTags(id)),
            ...news.tags,
          };

          // Observe — locate by cached id or recover by fronted ARN.
          let observed = output?.vpcOriginId
            ? yield* getById(output.vpcOriginId)
            : undefined;
          if (!observed) {
            observed = yield* getByArn(news.arn);
          }

          // Ensure — create the VPC origin if it's missing. Tolerate an
          // `EntityAlreadyExists` race by recovering via the fronted ARN.
          if (!observed) {
            const created = yield* cloudfront
              .createVpcOrigin({
                VpcOriginEndpointConfig: desiredEndpointConfig(name, news),
                Tags: { Items: createTagsList(desiredTags) },
              })
              .pipe(
                Effect.map((result) =>
                  result.VpcOrigin?.Id
                    ? { vpcOrigin: result.VpcOrigin, etag: result.ETag }
                    : undefined,
                ),
                Effect.catchTag("EntityAlreadyExists", () =>
                  getByArn(news.arn),
                ),
              );

            if (!created?.vpcOrigin.Id) {
              return yield* Effect.fail(
                new Error("createVpcOrigin returned no identifier"),
              );
            }

            yield* session.note(created.vpcOrigin.Id);
            const deployed = yield* waitForDeployment(created.vpcOrigin.Id);
            const tags = yield* fetchTags(deployed.vpcOrigin.Arn);
            return toAttrs(deployed.vpcOrigin, deployed.etag, tags);
          }

          // Sync endpoint config — patch only when the observed config differs
          // from desired, using the freshly observed ETag for concurrency.
          const desired = desiredEndpointConfig(name, news);
          let current = observed;
          if (
            !endpointConfigEquals(
              observed.vpcOrigin.VpcOriginEndpointConfig,
              desired,
            )
          ) {
            yield* cloudfront.updateVpcOrigin({
              Id: observed.vpcOrigin.Id,
              IfMatch: observed.etag ?? "",
              VpcOriginEndpointConfig: desired,
            });
            current = yield* waitForDeployment(observed.vpcOrigin.Id);
          } else if (observed.vpcOrigin.Status !== "Deployed") {
            current = yield* waitForDeployment(observed.vpcOrigin.Id);
          }

          // Sync tags — diff against observed cloud tags so adoption converges.
          const observedTags = yield* fetchTags(current.vpcOrigin.Arn);
          yield* syncTags(current.vpcOrigin.Arn, observedTags, desiredTags);

          yield* session.note(current.vpcOrigin.Id);
          return toAttrs(current.vpcOrigin, current.etag, desiredTags);
        }),
        delete: Effect.fn(function* ({ output }) {
          if (!output.vpcOriginId) {
            return;
          }
          // Observe current state. `deleteVpcOrigin` requires a terminal
          // `Deployed` status and the *current* ETag — `output.etag` may be
          // stale. If the origin is still `Deploying` (e.g. an interrupted
          // create), CloudFront refuses the delete and leaves the origin — and
          // its managed ENIs, which then block the VPC/ALB teardown —
          // orphaned. Wait for it to settle so it becomes deletable.
          const observed = yield* getById(output.vpcOriginId);
          if (!observed) {
            return; // already gone — idempotent
          }
          const current =
            observed.vpcOrigin.Status === "Deployed"
              ? observed
              : yield* waitForDeployment(output.vpcOriginId).pipe(
                  Effect.catch(() => Effect.succeed(observed)),
                );
          yield* cloudfront
            .deleteVpcOrigin({
              Id: output.vpcOriginId,
              IfMatch: current.etag ?? observed.etag ?? "",
            })
            .pipe(
              Effect.catchTag("EntityNotFound", () => Effect.void),
              // The VPC origin may still be referenced by a distribution origin
              // that is mid-removal; retry on the in-use signal.
              Effect.catchTag("CannotDeleteEntityWhileInUse", (error) =>
                Effect.fail(
                  new VpcOriginStillInUse({
                    message: error.Message ?? "VPC origin still in use",
                  }),
                ),
              ),
              Effect.retry({
                while: (error) => error._tag === "VpcOriginStillInUse",
                schedule: Schedule.max([
                  Schedule.fixed("10 seconds"),
                  Schedule.recurs(30),
                ]),
              }),
            );
          // Block until the origin record is fully gone so dependents (the
          // fronted ALB/VPC, held by CloudFront's ENIs) can be torn down.
          yield* Effect.repeat(
            getById(output.vpcOriginId).pipe(
              Effect.map((o) => o !== undefined),
            ),
            {
              schedule: Schedule.max([
                Schedule.fixed("10 seconds"),
                Schedule.recurs(30),
              ]),
              until: (exists) => exists === false,
            },
          ).pipe(Effect.catch(() => Effect.void));
        }),
      };
    }),
  );

const createName = (id: string, props: VpcOriginProps) =>
  props.name
    ? Effect.succeed(props.name)
    : createPhysicalName({
        id,
        maxLength: 64,
      });

const toTagsRecord = (tags: cloudfront.Tag[] | undefined) =>
  Object.fromEntries(
    (tags ?? [])
      .filter(
        (tag): tag is { Key: string; Value: string } =>
          typeof tag.Key === "string" && typeof tag.Value === "string",
      )
      .map((tag) => [tag.Key, tag.Value]),
  );

const toAttrs = (
  vpcOrigin: cloudfront.VpcOrigin,
  etag: string | undefined,
  tags: Record<string, string>,
): VpcOrigin["Attributes"] => ({
  vpcOriginId: vpcOrigin.Id,
  vpcOriginArn: vpcOrigin.Arn,
  status: vpcOrigin.Status,
  name: vpcOrigin.VpcOriginEndpointConfig.Name,
  arn: vpcOrigin.VpcOriginEndpointConfig.Arn,
  createdTime: vpcOrigin.CreatedTime,
  lastModifiedTime: vpcOrigin.LastModifiedTime,
  etag,
  tags,
});
