import * as Lambda from "@/AWS/Lambda";
import * as MediaConnect from "@/AWS/MediaConnect";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

export class MediaConnectTestFunction extends Lambda.Function<Lambda.Function>()(
  "MediaConnectTestFunction",
) {}

export default MediaConnectTestFunction.make(
  {
    main,
    url: true,
    // The gated /start-stop roundtrip waits for the flow to accept StopFlow.
    timeout: Duration.seconds(120),
  },
  Effect.gen(function* () {
    // The flow the flow-scoped bindings are bound to. It is created in
    // STANDBY (which does not bill for transport) and nothing ever sends
    // media to it, so the observability ops see the typed
    // not-running/no-content behavior.
    const flow = yield* MediaConnect.Flow("BindingFlow", {
      source: {
        Name: "primary",
        Protocol: "rtp",
        WhitelistCidr: "10.24.34.0/23",
        IngestPort: 5000,
      },
      tags: { fixture: "mediaconnect-bindings" },
    });

    // Event source: subscribe the host to MediaConnect alert/status events.
    // The deploy proves the EventBridge rule + invoke permission wiring.
    yield* MediaConnect.consumeFlowEvents(
      { kinds: ["alert", "flow-status-change"] },
      (events) =>
        Stream.runForEach(events, (event) =>
          Effect.log(
            `mediaconnect event: ${event["detail-type"]} ${event.detail.message ?? event.detail.status ?? ""}`,
          ),
        ),
    );

    // Accessor for the flow's ARN, resolvable inside the runtime fetch
    // handler (the entitlement roundtrip derives the account id from it).
    const FlowArn = yield* flow.flowArn;

    const describeFlow = yield* MediaConnect.DescribeFlow(flow);
    const sourceMetadata = yield* MediaConnect.DescribeFlowSourceMetadata(flow);
    const sourceThumbnail =
      yield* MediaConnect.DescribeFlowSourceThumbnail(flow);
    const startFlow = yield* MediaConnect.StartFlow(flow);
    const stopFlow = yield* MediaConnect.StopFlow(flow);
    const grantEntitlements = yield* MediaConnect.GrantFlowEntitlements(flow);
    const revokeEntitlement = yield* MediaConnect.RevokeFlowEntitlement(flow);
    const listFlows = yield* MediaConnect.ListFlows();
    const listEntitlements = yield* MediaConnect.ListEntitlements();

    const bound = {
      describeFlow,
      sourceMetadata,
      sourceThumbnail,
      startFlow,
      stopFlow,
      grantEntitlements,
      revokeEntitlement,
      listFlows,
      listEntitlements,
    };

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;

        if (request.method === "GET" && pathname === "/bindings") {
          return yield* HttpServerResponse.json({
            bound: Object.keys(bound),
          });
        }

        // Read the flow's live state — the fixture flow idles in STANDBY.
        if (request.method === "GET" && pathname === "/flow") {
          const { Flow: current } = yield* describeFlow();
          return yield* HttpServerResponse.json({
            status: current?.Status,
            sourceName: current?.Source?.Name,
          });
        }

        // Transport-stream metadata on a flow that is not receiving
        // content: MediaConnect answers with status messages (or a typed
        // BadRequestException while the flow is not running).
        if (request.method === "GET" && pathname === "/source-metadata") {
          const result = yield* sourceMetadata().pipe(
            Effect.map(({ TransportMediaInfo, Messages }) => ({
              programs: TransportMediaInfo?.Programs?.length ?? 0,
              messages: (Messages ?? []).length,
              tag: undefined as string | undefined,
            })),
            Effect.catchTag("BadRequestException", (e) =>
              Effect.succeed({ programs: 0, messages: 0, tag: e._tag }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        // Source thumbnail on an idle flow: no image, only messages (or a
        // typed BadRequestException while the flow is not running).
        if (request.method === "GET" && pathname === "/thumbnail") {
          const result = yield* sourceThumbnail().pipe(
            Effect.map(({ ThumbnailDetails }) => ({
              hasImage: ThumbnailDetails?.Thumbnail !== undefined,
              messages: ThumbnailDetails?.ThumbnailMessages?.length ?? 0,
              tag: undefined as string | undefined,
            })),
            Effect.catchTag("BadRequestException", (e) =>
              Effect.succeed({ hasImage: false, messages: 0, tag: e._tag }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        // Account-level enumerations.
        if (request.method === "GET" && pathname === "/flows") {
          const { Flows } = yield* listFlows({ MaxResults: 20 });
          return yield* HttpServerResponse.json({
            count: (Flows ?? []).length,
          });
        }
        if (request.method === "GET" && pathname === "/entitlements") {
          const { Entitlements } = yield* listEntitlements();
          return yield* HttpServerResponse.json({
            count: (Entitlements ?? []).length,
          });
        }

        // Stopping a flow that is already in STANDBY: the typed
        // BadRequestException tag is the real observable behavior.
        if (request.method === "POST" && pathname === "/stop") {
          const result = yield* stopFlow().pipe(
            Effect.map(({ Status }) => ({
              status: Status,
              tag: undefined as string | undefined,
            })),
            Effect.catchTag("BadRequestException", (e) =>
              Effect.succeed({
                status: undefined as string | undefined,
                tag: e._tag,
              }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        // Grant an entitlement to this very account, then revoke it —
        // a full grant/revoke roundtrip with no cross-account dependency.
        // Failures surface as their typed tag so the test can diagnose
        // (e.g. an IAM gap is a visible ForbiddenException, not a 500).
        if (request.method === "POST" && pathname === "/entitlement-cycle") {
          const flowArn = yield* FlowArn;
          const accountId = flowArn.split(":")[4]!;
          const result = yield* grantEntitlements({
            Entitlements: [
              {
                Name: "alchemy-binding-test",
                Subscribers: [accountId],
              },
            ],
          }).pipe(
            Effect.flatMap(({ Entitlements }) => {
              const entitlementArn = Entitlements?.[0]?.EntitlementArn;
              if (entitlementArn === undefined) {
                return Effect.succeed({
                  granted: false,
                  revoked: false,
                  tag: undefined as string | undefined,
                });
              }
              return revokeEntitlement({
                EntitlementArn: entitlementArn,
              }).pipe(
                Effect.map(() => ({
                  granted: true,
                  revoked: true,
                  tag: undefined as string | undefined,
                })),
              );
            }),
            Effect.catchTag(
              [
                "BadRequestException",
                "GrantFlowEntitlements420Exception",
                "ForbiddenException",
                "NotFoundException",
              ],
              (e) =>
                Effect.succeed({
                  granted: false,
                  revoked: false,
                  tag: e._tag as string | undefined,
                }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        // Start the flow, then stop it as soon as MediaConnect accepts a
        // StopFlow (a STARTING flow rejects it with BadRequestException).
        // Only driven by the AWS_TEST_MEDIACONNECT-gated test: an ACTIVE
        // flow bills for transport by the hour.
        if (request.method === "POST" && pathname === "/start-stop") {
          const { Status: startStatus } = yield* startFlow();
          const { Status: stopStatus } = yield* stopFlow().pipe(
            Effect.retry({
              while: (e): boolean => e._tag === "BadRequestException",
              schedule: Schedule.max([
                Schedule.fixed("5 seconds"),
                Schedule.recurs(18),
              ]),
            }),
          );
          return yield* HttpServerResponse.json({
            startStatus,
            stopStatus,
          });
        }

        return yield* HttpServerResponse.json(
          { error: "Not found", method: request.method, pathname },
          { status: 404 },
        );
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Lambda.EventSource,
        MediaConnect.DescribeFlowHttp,
        MediaConnect.DescribeFlowSourceMetadataHttp,
        MediaConnect.DescribeFlowSourceThumbnailHttp,
        MediaConnect.StartFlowHttp,
        MediaConnect.StopFlowHttp,
        MediaConnect.GrantFlowEntitlementsHttp,
        MediaConnect.RevokeFlowEntitlementHttp,
        MediaConnect.ListFlowsHttp,
        MediaConnect.ListEntitlementsHttp,
      ),
    ),
  ),
);
