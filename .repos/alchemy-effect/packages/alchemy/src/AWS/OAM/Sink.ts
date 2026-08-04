import * as oam from "@distilled.cloud/aws/oam";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { hasAlchemyTags } from "../../Tags.ts";
import type { Providers } from "../Providers.ts";
import {
  deleteSinkAndWait,
  readOamTags,
  retryOamMutation,
  syncOamTags,
} from "./internal.ts";

export interface SinkProps {
  /**
   * Name of the sink. If omitted, a unique name is generated from the app,
   * stage and logical ID. Changing the name replaces the sink.
   */
  sinkName?: string;

  /**
   * The IAM resource policy that grants source accounts permission to link
   * to this sink (`oam:CreateLink` / `oam:UpdateLink`). Provided as a JSON
   * string or a plain policy document object.
   *
   * OAM has no delete-sink-policy API, so removing this prop leaves the
   * last applied policy in place.
   */
  policy?: string | Record<string, any>;

  /**
   * User tags to attach to the sink. Merged with internal Alchemy tags.
   */
  tags?: Record<string, string>;
}

export interface Sink extends Resource<
  "AWS.OAM.Sink",
  SinkProps,
  {
    /** The name of the sink. */
    sinkName: string;
    /** The ARN of the sink (used as the `sinkIdentifier` of a `Link`). */
    sinkArn: string;
    /** The random ID string that AWS generated as part of the sink ARN. */
    sinkId: string;
  },
  never,
  Providers
> {}

/**
 * A CloudWatch cross-account observability **sink** — the attachment point
 * in a monitoring account that source accounts link to in order to share
 * metrics, logs, traces, and Application Signals data.
 *
 * Each account can contain **one sink per region**. After creating a sink,
 * attach a sink policy (the `policy` prop) that authorizes source accounts
 * (or an entire organization) to create links to it.
 *
 * @resource
 * @section Creating a Sink
 * @example Basic Sink
 * ```typescript
 * import * as OAM from "alchemy/AWS/OAM";
 *
 * const sink = yield* OAM.Sink("MonitoringSink");
 * ```
 *
 * @example Sink with a policy authorizing source accounts
 * ```typescript
 * const sink = yield* OAM.Sink("MonitoringSink", {
 *   policy: {
 *     Version: "2012-10-17",
 *     Statement: [
 *       {
 *         Effect: "Allow",
 *         Principal: { AWS: ["111122223333"] },
 *         Action: ["oam:CreateLink", "oam:UpdateLink"],
 *         Resource: "*",
 *         Condition: {
 *           "ForAllValues:StringEquals": {
 *             "oam:ResourceTypes": [
 *               "AWS::CloudWatch::Metric",
 *               "AWS::Logs::LogGroup",
 *             ],
 *           },
 *         },
 *       },
 *     ],
 *   },
 * });
 * ```
 *
 * @example Authorize an entire organization
 * ```typescript
 * const sink = yield* OAM.Sink("OrgSink", {
 *   policy: {
 *     Version: "2012-10-17",
 *     Statement: [
 *       {
 *         Effect: "Allow",
 *         Principal: "*",
 *         Action: ["oam:CreateLink", "oam:UpdateLink"],
 *         Resource: "*",
 *         Condition: {
 *           "ForAnyValue:StringEquals": { "aws:PrincipalOrgID": "o-xxxxxxxxxx" },
 *         },
 *       },
 *     ],
 *   },
 * });
 * ```
 */
export const Sink = Resource<Sink>("AWS.OAM.Sink");

/** Normalize a `policy` prop to a JSON string for `putSinkPolicy`. */
const toPolicyString = (policy: string | Record<string, any>): string =>
  typeof policy === "string" ? policy : JSON.stringify(policy);

/**
 * Semantic policy equality — AWS normalizes documents (e.g. account-ID
 * principals become `arn:aws:iam::…:root`), so a raw string compare would
 * re-put an unchanged policy forever. We compare parsed JSON; a normalized
 * difference still re-puts, which is idempotent and harmless.
 */
const samePolicy = (a: string | undefined, b: string | undefined): boolean => {
  if (a === undefined || b === undefined) return a === b;
  try {
    return JSON.stringify(JSON.parse(a)) === JSON.stringify(JSON.parse(b));
  } catch {
    return a === b;
  }
};

export const SinkProvider = () =>
  Provider.effect(
    Sink,
    Effect.gen(function* () {
      // `props` may be undefined at runtime — all SinkProps fields are
      // optional, so callers can omit the props object entirely.
      const createName = Effect.fn(function* (
        id: string,
        props: SinkProps | undefined,
      ) {
        return props?.sinkName ?? (yield* createPhysicalName({ id }));
      });

      // Find a sink by name via the (small — quota is 1/region) list API.
      const findByName = Effect.fn(function* (sinkName: string) {
        const pages = yield* oam.listSinks.pages({}).pipe(Stream.runCollect);
        return Array.from(pages)
          .flatMap((page) => page.Items)
          .find((item) => item.Name === sinkName);
      });

      return Sink.Provider.of({
        stables: ["sinkName", "sinkArn", "sinkId"],
        list: () =>
          oam.listSinks.pages({}).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((page) =>
                page.Items.filter(
                  (item) =>
                    item.Name != null && item.Arn != null && item.Id != null,
                ).map((item) => ({
                  sinkName: item.Name!,
                  sinkArn: item.Arn!,
                  sinkId: item.Id!,
                })),
              ),
            ),
          ),
        read: Effect.fn(function* ({ id, olds, output }) {
          const sinkName =
            output?.sinkName ?? (yield* createName(id, olds ?? {}));
          const found = output?.sinkArn
            ? yield* oam
                .getSink({ Identifier: output.sinkArn })
                .pipe(
                  Effect.catchTag("ResourceNotFoundException", () =>
                    Effect.succeed(undefined),
                  ),
                )
            : yield* findByName(sinkName);
          if (!found?.Arn) return undefined;
          const attrs = {
            sinkName: found.Name ?? sinkName,
            sinkArn: found.Arn,
            sinkId: found.Id!,
          };
          const tags = yield* readOamTags(found.Arn);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),
        diff: Effect.fn(function* ({ id, news, olds }) {
          if (!isResolved(news)) return undefined;
          const oldName = yield* createName(id, olds);
          const newName = yield* createName(id, news);
          if (oldName !== newName) return { action: "replace" } as const;
          return undefined;
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const sinkName = output?.sinkName ?? (yield* createName(id, news));

          // OBSERVE — cloud state is authoritative; `output` is only an
          // identifier cache. A cached ARN that no longer resolves falls
          // through to "missing".
          let live = output?.sinkArn
            ? yield* oam
                .getSink({ Identifier: output.sinkArn })
                .pipe(
                  Effect.catchTag("ResourceNotFoundException", () =>
                    Effect.succeed(undefined),
                  ),
                )
            : yield* findByName(sinkName);

          // ENSURE — create when missing; a ConflictException means a peer
          // created the same-named sink concurrently, so re-observe.
          if (live?.Arn == null) {
            live = yield* retryOamMutation(
              oam.createSink({ Name: sinkName, Tags: news?.tags }),
            ).pipe(
              Effect.catchTag("ConflictException", () => findByName(sinkName)),
            );
          }
          const sinkArn = live!.Arn!;
          const sinkId = live!.Id!;

          // SYNC policy — diff the OBSERVED sink policy against the desired
          // document and put only on change. There is no delete-policy API,
          // so an absent `policy` prop leaves the current policy untouched.
          const desiredPolicy = news?.policy;
          if (desiredPolicy !== undefined) {
            const desired = toPolicyString(desiredPolicy);
            const observed = yield* oam
              .getSinkPolicy({ SinkIdentifier: sinkArn })
              .pipe(
                Effect.map((r) => r.Policy),
                Effect.catchTag("ResourceNotFoundException", () =>
                  Effect.succeed(undefined),
                ),
              );
            if (!samePolicy(observed, desired)) {
              yield* retryOamMutation(
                oam.putSinkPolicy({
                  SinkIdentifier: sinkArn,
                  Policy: desired,
                }),
              );
            }
          }

          // SYNC tags — against observed cloud tags (adoption-safe).
          yield* syncOamTags(sinkArn, id, news?.tags);

          yield* session.note(sinkArn);
          return { sinkName, sinkArn, sinkId };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* deleteSinkAndWait(output.sinkArn);
        }),
      });
    }),
  );
