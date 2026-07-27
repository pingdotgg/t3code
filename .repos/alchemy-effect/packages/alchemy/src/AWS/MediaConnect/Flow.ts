import * as mediaconnect from "@distilled.cloud/aws/mediaconnect";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, diffTags, hasAlchemyTags } from "../../Tags.ts";
import type { Providers } from "../Providers.ts";

/**
 * Every flow output managed by alchemy must carry a `Name` so the reconciler
 * can converge outputs by identity across updates.
 */
export class FlowOutputNameMissing extends Data.TaggedError(
  "FlowOutputNameMissing",
)<{ message: string }> {}

export interface FlowProps {
  /**
   * Name of the flow. If omitted, a deterministic physical name is generated
   * from the app, stage and logical ID. Changing the name replaces the flow
   * (MediaConnect has no rename operation).
   */
  flowName?: string;
  /**
   * Availability Zone the flow is created in. Must be within the current
   * region. Changing the Availability Zone replaces the flow.
   * @default MediaConnect picks an Availability Zone
   */
  availabilityZone?: string;
  /**
   * The source the flow ingests. Raw distilled `SetSourceRequest` shape —
   * e.g. `{ Protocol: "rtp", WhitelistCidr: "10.0.0.0/8", IngestPort: 5000 }`.
   * Mutable source settings (protocol, whitelist CIDR, ingest port, bitrate,
   * latency, stream id, sender address/port, description) are updated in
   * place via UpdateFlowSource.
   */
  source: mediaconnect.SetSourceRequest;
  /**
   * Outputs of the flow (up to 50). Each output MUST have a `Name` — the
   * reconciler converges outputs by name: missing outputs are added, extra
   * non-entitlement outputs are removed, and changed settings (destination,
   * port, protocol, CIDR allow list, latency, description) are updated in
   * place.
   * @default no outputs
   */
  outputs?: mediaconnect.AddOutputRequest[];
  /**
   * User-defined tags for the flow.
   */
  tags?: Record<string, string>;
}

export interface Flow extends Resource<
  "AWS.MediaConnect.Flow",
  FlowProps,
  {
    /** Name of the flow. */
    flowName: string;
    /** ARN of the flow. */
    flowArn: string;
    /** Current status — a freshly created flow is `STANDBY` (not billing for transport). */
    status: string;
    /** Availability Zone the flow runs in. */
    availabilityZone: string;
    /** Flow description, if any. */
    description: string | undefined;
    /** IP address the flow egresses media from. */
    egressIp: string | undefined;
    /** ARN of the flow's source. */
    sourceArn: string | undefined;
    /** IP address the flow listens on for incoming content. */
    sourceIngestIp: string | undefined;
    /** Port the flow listens on for incoming content. */
    sourceIngestPort: number | undefined;
    /** The flow's outputs (name, ARN, destination endpoint). */
    outputs: {
      name: string;
      outputArn: string;
      destination: string | undefined;
      port: number | undefined;
      listenerAddress: string | undefined;
    }[];
    /** Observed tags on the flow. */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An AWS Elemental MediaConnect flow — a reliable live-video transport
 * between a source and one or more outputs.
 *
 * Creating a flow leaves it in `STANDBY`; a flow only ingests/egresses media
 * (and bills for transport) once started with the StartFlow API. Flows bill
 * hourly while ACTIVE, so alchemy never starts a flow implicitly.
 * @resource
 * @section Creating a Flow
 * @example RTP Flow with a CIDR-Whitelisted Source
 * ```typescript
 * const flow = yield* Flow("Broadcast", {
 *   source: {
 *     Name: "primary",
 *     Protocol: "rtp",
 *     WhitelistCidr: "10.24.34.0/23",
 *     IngestPort: 5000,
 *   },
 * });
 * ```
 *
 * @section Outputs
 * @example Flow with an RTP Output
 * ```typescript
 * const flow = yield* Flow("Distribution", {
 *   source: {
 *     Name: "primary",
 *     Protocol: "rtp",
 *     WhitelistCidr: "10.24.34.0/23",
 *     IngestPort: 5000,
 *   },
 *   outputs: [
 *     {
 *       Name: "affiliate-east",
 *       Protocol: "rtp",
 *       Destination: "198.51.100.11",
 *       Port: 5010,
 *     },
 *   ],
 * });
 * ```
 *
 * @section Tags
 * @example Tagged Flow
 * ```typescript
 * const flow = yield* Flow("Broadcast", {
 *   source: { Protocol: "rtp", WhitelistCidr: "10.0.0.0/8", IngestPort: 5000 },
 *   tags: { team: "live-video" },
 * });
 * ```
 */
export const Flow = Resource<Flow>("AWS.MediaConnect.Flow");

type DescribedFlow = NonNullable<mediaconnect.DescribeFlowResponse["Flow"]>;
// The element type of a described flow's Outputs, INCLUDING the response
// refinements (required Name/OutputArn). Note: DescribedFlow["Outputs"] is an
// intersection of array types, so `.map` resolves its callback against the
// base `Output[]` signature and drops these refinements — iterate with
// `for..of` (which uses the number-index element type) instead of `.map`.
type ObservedOutput = DescribedFlow["Outputs"][number];

const sameStringList = (a: string[] | undefined, b: string[] | undefined) => {
  const l = [...(a ?? [])].sort();
  const r = [...(b ?? [])].sort();
  return l.length === r.length && l.every((v, i) => v === r[i]);
};

export const FlowProvider = () =>
  Provider.effect(
    Flow,
    Effect.gen(function* () {
      const toName = (id: string, props: { flowName?: string }) =>
        props.flowName
          ? Effect.succeed(props.flowName)
          : createPhysicalName({ id, maxLength: 60 });

      const readFlow = Effect.fn(function* (flowArn: string) {
        const response = yield* mediaconnect
          .describeFlow({ FlowArn: flowArn })
          .pipe(
            Effect.catchTag("NotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
        return response?.Flow;
      });

      // Flow names are not unique in MediaConnect — identity is the ARN.
      // When the ARN cache is lost (state persistence failure) fall back to
      // the first flow bearing our deterministic name.
      const findFlowArnByName = Effect.fn(function* (name: string) {
        const flows = yield* mediaconnect.listFlows
          .items({})
          .pipe(Stream.runCollect);
        for (const flow of flows) {
          if (flow.Name === name && flow.FlowArn !== undefined) {
            return flow.FlowArn;
          }
        }
        return undefined;
      });

      const readFlowTags = Effect.fn(function* (flowArn: string) {
        const response = yield* mediaconnect
          .listTagsForResource({ ResourceArn: flowArn })
          .pipe(
            Effect.catchTag("NotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
        const tags: Record<string, string> = {};
        for (const [key, value] of Object.entries(response?.Tags ?? {})) {
          if (value !== undefined) tags[key] = value;
        }
        return tags;
      });

      // Flow creation and in-place updates are async; wait (bounded, ~3 min)
      // for the flow to settle into a steady state before mutating further.
      const waitUntilSettled = Effect.fn(function* (flowArn: string) {
        const policy = Schedule.max([
          Schedule.fixed("5 seconds"),
          Schedule.recurs(36),
        ]);
        return yield* readFlow(flowArn).pipe(
          Effect.flatMap((flow) => {
            if (flow === undefined) {
              return Effect.fail(
                new Error(`MediaConnect flow '${flowArn}' not found`),
              );
            }
            if (
              flow.Status !== "STANDBY" &&
              flow.Status !== "ACTIVE" &&
              flow.Status !== "ERROR"
            ) {
              return Effect.fail(
                new Error(
                  `MediaConnect flow '${flowArn}' still settling (status: ${flow.Status})`,
                ),
              );
            }
            return Effect.succeed(flow);
          }),
          Effect.retry({ schedule: policy }),
        );
      });

      // Deletion is verified as fully gone (bounded, ~3 min) so dependents
      // (and re-creates of the same name) never race a half-deleted flow.
      const waitUntilGone = Effect.fn(function* (flowArn: string) {
        const policy = Schedule.max([
          Schedule.fixed("5 seconds"),
          Schedule.recurs(36),
        ]);
        yield* readFlow(flowArn).pipe(
          Effect.flatMap((flow) =>
            flow === undefined
              ? Effect.void
              : Effect.fail(
                  new Error(
                    `MediaConnect flow '${flowArn}' still exists (status: ${flow.Status})`,
                  ),
                ),
          ),
          Effect.retry({ schedule: policy }),
        );
      });

      const toAttrs = Effect.fn(function* (flow: DescribedFlow) {
        const outputs: {
          name: string;
          outputArn: string;
          destination: string | undefined;
          port: number | undefined;
          listenerAddress: string | undefined;
        }[] = [];
        for (const output of flow.Outputs ?? []) {
          outputs.push({
            name: output.Name,
            outputArn: output.OutputArn,
            destination: output.Destination,
            port: output.Port,
            listenerAddress: output.ListenerAddress,
          });
        }
        return {
          flowName: flow.Name,
          flowArn: flow.FlowArn,
          status: flow.Status,
          availabilityZone: flow.AvailabilityZone,
          description: flow.Description,
          egressIp: flow.EgressIp,
          sourceArn: flow.Source?.SourceArn,
          sourceIngestIp: flow.Source?.IngestIp,
          sourceIngestPort: flow.Source?.IngestPort,
          outputs,
          tags: yield* readFlowTags(flow.FlowArn),
        };
      });

      return {
        stables: ["flowName", "flowArn", "availabilityZone"],

        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return undefined;
          const oldName = yield* toName(id, { flowName: olds?.flowName });
          const newName = yield* toName(id, { flowName: news?.flowName });
          if (oldName !== newName) {
            return { action: "replace" } as const;
          }
          // The Availability Zone is create-only.
          if (
            news?.availabilityZone !== undefined &&
            olds?.availabilityZone !== undefined &&
            news.availabilityZone !== olds.availabilityZone
          ) {
            return { action: "replace" } as const;
          }
        }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const name = output?.flowName ?? (yield* toName(id, olds ?? {}));
          const arn = output?.flowArn ?? (yield* findFlowArnByName(name));
          if (arn === undefined) return undefined;
          const flow = yield* readFlow(arn);
          if (flow === undefined) return undefined;
          const attrs = yield* toAttrs(flow);
          return (yield* hasAlchemyTags(id, attrs.tags))
            ? attrs
            : Unowned(attrs);
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const props = news!;
          const name = output?.flowName ?? (yield* toName(id, props));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...props.tags };

          // Validate up front (before any AWS call): outputs are converged
          // by name, so every desired output must carry one.
          const desiredOutputs: (mediaconnect.AddOutputRequest & {
            Name: string;
          })[] = [];
          for (const desired of props.outputs ?? []) {
            if (desired.Name === undefined) {
              return yield* Effect.fail(
                new FlowOutputNameMissing({
                  message: `every output of MediaConnect flow '${name}' must set a Name — outputs are converged by name`,
                }),
              );
            }
            desiredOutputs.push({ ...desired, Name: desired.Name });
          }

          // 1. Observe — cloud state is authoritative; output is only an
          //    ARN cache (flow names are not unique, so fall back to search).
          let arn = output?.flowArn ?? (yield* findFlowArnByName(name));
          let observed = arn !== undefined ? yield* readFlow(arn) : undefined;

          // 2. Ensure — create if missing. Creation leaves the flow in
          //    STANDBY; alchemy never starts a flow (ACTIVE bills hourly).
          if (observed === undefined) {
            const created = yield* mediaconnect.createFlow({
              Name: name,
              AvailabilityZone: props.availabilityZone,
              Source: props.source,
              Outputs: desiredOutputs.length > 0 ? desiredOutputs : undefined,
            });
            arn = created.Flow?.FlowArn;
          }
          if (arn === undefined) {
            return yield* Effect.fail(
              new Error(`MediaConnect flow '${name}' is missing its ARN`),
            );
          }
          observed = yield* waitUntilSettled(arn);

          // 3. Sync source — diff OBSERVED source settings against desired
          //    and apply only the delta via UpdateFlowSource.
          const source = observed.Source;
          if (source?.SourceArn !== undefined) {
            const desired = props.source;
            const transport = source.Transport;
            const update: Omit<
              mediaconnect.UpdateFlowSourceRequest,
              "FlowArn" | "SourceArn"
            > = {};
            let mutated = false;
            if (
              desired.Description !== undefined &&
              desired.Description !== source.Description
            ) {
              update.Description = desired.Description;
              mutated = true;
            }
            if (
              desired.Protocol !== undefined &&
              desired.Protocol !== transport?.Protocol
            ) {
              update.Protocol = desired.Protocol;
              mutated = true;
            }
            if (
              desired.WhitelistCidr !== undefined &&
              desired.WhitelistCidr !== source.WhitelistCidr
            ) {
              update.WhitelistCidr = desired.WhitelistCidr;
              mutated = true;
            }
            if (
              desired.IngestPort !== undefined &&
              desired.IngestPort !== source.IngestPort
            ) {
              update.IngestPort = desired.IngestPort;
              mutated = true;
            }
            if (
              desired.MaxBitrate !== undefined &&
              desired.MaxBitrate !== transport?.MaxBitrate
            ) {
              update.MaxBitrate = desired.MaxBitrate;
              mutated = true;
            }
            if (
              desired.MaxLatency !== undefined &&
              desired.MaxLatency !== transport?.MaxLatency
            ) {
              update.MaxLatency = desired.MaxLatency;
              mutated = true;
            }
            if (
              desired.MinLatency !== undefined &&
              desired.MinLatency !== transport?.MinLatency
            ) {
              update.MinLatency = desired.MinLatency;
              mutated = true;
            }
            if (
              desired.StreamId !== undefined &&
              desired.StreamId !== transport?.StreamId
            ) {
              update.StreamId = desired.StreamId;
              mutated = true;
            }
            if (
              desired.SenderIpAddress !== undefined &&
              desired.SenderIpAddress !== source.SenderIpAddress
            ) {
              update.SenderIpAddress = desired.SenderIpAddress;
              mutated = true;
            }
            if (
              desired.SenderControlPort !== undefined &&
              desired.SenderControlPort !== source.SenderControlPort
            ) {
              update.SenderControlPort = desired.SenderControlPort;
              mutated = true;
            }
            if (mutated) {
              yield* mediaconnect.updateFlowSource({
                ...update,
                FlowArn: arn,
                SourceArn: source.SourceArn,
              });
              observed = yield* waitUntilSettled(arn);
            }
          }

          // 3b. Sync outputs by name — add missing, update drifted, remove
          //     extras (entitlement-generated outputs are not ours to remove).
          const observedOutputs = observed.Outputs ?? [];
          const observedByName = new Map<string, ObservedOutput>();
          for (const observedOutput of observedOutputs) {
            observedByName.set(observedOutput.Name, observedOutput);
          }
          const desiredNames = new Set(desiredOutputs.map((o) => o.Name));
          let outputsMutated = false;

          const toAdd = desiredOutputs.filter(
            (o) => !observedByName.has(o.Name),
          );
          if (toAdd.length > 0) {
            yield* mediaconnect.addFlowOutputs({
              FlowArn: arn,
              Outputs: toAdd,
            });
            outputsMutated = true;
          }

          for (const existing of observedOutputs) {
            if (
              !desiredNames.has(existing.Name) &&
              existing.EntitlementArn === undefined
            ) {
              yield* mediaconnect
                .removeFlowOutput({
                  FlowArn: arn,
                  OutputArn: existing.OutputArn,
                })
                .pipe(Effect.catchTag("NotFoundException", () => Effect.void));
              outputsMutated = true;
            }
          }

          for (const desired of desiredOutputs) {
            const existing = observedByName.get(desired.Name);
            if (existing === undefined) continue;
            const transport = existing.Transport;
            const update: Omit<
              mediaconnect.UpdateFlowOutputRequest,
              "FlowArn" | "OutputArn"
            > = {};
            let mutated = false;
            if (
              desired.Description !== undefined &&
              desired.Description !== existing.Description
            ) {
              update.Description = desired.Description;
              mutated = true;
            }
            if (
              desired.Destination !== undefined &&
              desired.Destination !== existing.Destination
            ) {
              update.Destination = desired.Destination;
              mutated = true;
            }
            if (desired.Port !== undefined && desired.Port !== existing.Port) {
              update.Port = desired.Port;
              mutated = true;
            }
            if (
              desired.Protocol !== undefined &&
              desired.Protocol !== transport?.Protocol
            ) {
              update.Protocol = desired.Protocol;
              mutated = true;
            }
            if (
              desired.CidrAllowList !== undefined &&
              !sameStringList(desired.CidrAllowList, transport?.CidrAllowList)
            ) {
              update.CidrAllowList = desired.CidrAllowList;
              mutated = true;
            }
            if (
              desired.MaxLatency !== undefined &&
              desired.MaxLatency !== transport?.MaxLatency
            ) {
              update.MaxLatency = desired.MaxLatency;
              mutated = true;
            }
            if (
              desired.MinLatency !== undefined &&
              desired.MinLatency !== transport?.MinLatency
            ) {
              update.MinLatency = desired.MinLatency;
              mutated = true;
            }
            if (
              desired.SmoothingLatency !== undefined &&
              desired.SmoothingLatency !== transport?.SmoothingLatency
            ) {
              update.SmoothingLatency = desired.SmoothingLatency;
              mutated = true;
            }
            if (
              desired.StreamId !== undefined &&
              desired.StreamId !== transport?.StreamId
            ) {
              update.StreamId = desired.StreamId;
              mutated = true;
            }
            if (
              desired.RemoteId !== undefined &&
              desired.RemoteId !== transport?.RemoteId
            ) {
              update.RemoteId = desired.RemoteId;
              mutated = true;
            }
            if (mutated) {
              yield* mediaconnect.updateFlowOutput({
                ...update,
                FlowArn: arn,
                OutputArn: existing.OutputArn,
              });
              outputsMutated = true;
            }
          }
          if (outputsMutated) {
            observed = yield* waitUntilSettled(arn);
          }

          // 3c. Sync tags — diff against OBSERVED cloud tags.
          const observedTags = yield* readFlowTags(arn);
          const { removed, upsert } = diffTags(observedTags, desiredTags);
          if (upsert.length > 0) {
            yield* mediaconnect.tagResource({
              ResourceArn: arn,
              Tags: Object.fromEntries(upsert.map((t) => [t.Key, t.Value])),
            });
          }
          if (removed.length > 0) {
            yield* mediaconnect.untagResource({
              ResourceArn: arn,
              TagKeys: removed,
            });
          }

          yield* session.note(name);
          return yield* toAttrs(observed);
        }),

        delete: Effect.fn(function* ({ output }) {
          const arn = output.flowArn;
          const observed = yield* readFlow(arn);
          if (observed === undefined) return;
          // A flow must be stopped before it can be deleted. Alchemy never
          // starts flows, but the flow may have been started out-of-band.
          if (observed.Status === "ACTIVE" || observed.Status === "STARTING") {
            yield* mediaconnect.stopFlow({ FlowArn: arn }).pipe(
              // A STARTING flow rejects StopFlow until the start completes.
              Effect.retry({
                while: (e) => e._tag === "BadRequestException",
                schedule: Schedule.max([
                  Schedule.fixed("5 seconds"),
                  Schedule.recurs(12),
                ]),
              }),
              Effect.catchTag("NotFoundException", () => Effect.void),
            );
          }
          // Wait for any in-flight transition (STOPPING/UPDATING) to settle,
          // then delete. A flow already DELETING (or gone) is success.
          const settled = yield* waitUntilSettled(arn).pipe(
            Effect.catch(() => Effect.succeed(undefined)),
          );
          if (settled !== undefined) {
            yield* mediaconnect.deleteFlow({ FlowArn: arn }).pipe(
              // Status races (e.g. a transition that began after our read)
              // surface as BadRequestException — bounded retry through it.
              Effect.retry({
                while: (e) => e._tag === "BadRequestException",
                schedule: Schedule.max([
                  Schedule.fixed("5 seconds"),
                  Schedule.recurs(12),
                ]),
              }),
              Effect.catchTag("NotFoundException", () => Effect.void),
            );
          }
          yield* waitUntilGone(arn);
        }),

        list: () =>
          Effect.gen(function* () {
            const listed = yield* mediaconnect.listFlows
              .items({})
              .pipe(Stream.runCollect);
            const arns: string[] = [];
            for (const flow of listed) {
              if (flow.FlowArn !== undefined) arns.push(flow.FlowArn);
            }
            const flows = yield* Effect.forEach(arns, (arn) => readFlow(arn), {
              concurrency: 4,
            });
            return yield* Effect.forEach(
              flows.filter((flow): flow is DescribedFlow => flow !== undefined),
              (flow) => toAttrs(flow),
              { concurrency: 4 },
            );
          }),
      };
    }),
  );
