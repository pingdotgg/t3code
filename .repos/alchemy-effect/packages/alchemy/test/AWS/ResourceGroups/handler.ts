import * as IAM from "@/AWS/IAM";
import * as Lambda from "@/AWS/Lambda";
import * as ResourceGroups from "@/AWS/ResourceGroups";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

export class RGTestFunction extends Lambda.Function<Lambda.Function>()(
  "RGTestFunction",
) {}

/** Return a typed error tag + message instead of failing the route. */
const tagOf = <A extends object, E extends { _tag: string; message?: string }>(
  eff: Effect.Effect<A, E>,
) =>
  eff.pipe(
    Effect.map((ok) => ({ ok })),
    Effect.catch((e) =>
      Effect.succeed({ errorTag: e._tag, message: e.message }),
    ),
  );

export default RGTestFunction.make(
  {
    main,
    url: true,
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    // The group the group-scoped bindings are bound to. A capacity
    // reservation pool group is one of the config types GroupResources /
    // UngroupResources accept, and creating it is free (the pool starts
    // empty and never acquires capacity).
    const pool = yield* ResourceGroups.Group("BindingsPoolGroup", {
      description: "alchemy resource-groups bindings fixture pool",
      configuration: [
        {
          type: "AWS::ResourceGroups::Generic",
          parameters: [
            {
              name: "allowed-resource-types",
              values: ["AWS::EC2::CapacityReservation"],
            },
          ],
        },
        { type: "AWS::EC2::CapacityReservationPool" },
      ],
    });

    // Role a tag-sync task would run as (tag-sync itself is gated on
    // application groups, which cannot be created via CreateGroup — the
    // /start-tag-sync route asserts the typed rejection).
    const syncRole = yield* IAM.Role("BindingsTagSyncRole", {
      assumeRolePolicyDocument: {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { Service: "resource-groups.amazonaws.com" },
            Action: ["sts:AssumeRole"],
          },
        ],
      },
    });

    // Event source: subscribe the host to group lifecycle events. The
    // deploy proves the EventBridge rule + invoke permission wiring.
    yield* ResourceGroups.consumeGroupEvents(
      { kinds: ["state-change", "membership-change"] },
      (events) =>
        Stream.runForEach(events, (event) =>
          Effect.log(`group event: ${event["detail-type"]}`),
        ),
    );

    // --- group-scoped bindings ---
    const listGroupResources = yield* ResourceGroups.ListGroupResources(pool);
    const listGroupingStatuses =
      yield* ResourceGroups.ListGroupingStatuses(pool);
    const groupResources = yield* ResourceGroups.GroupResources(pool);
    const ungroupResources = yield* ResourceGroups.UngroupResources(pool);
    const startTagSyncTask = yield* ResourceGroups.StartTagSyncTask(
      pool,
      syncRole,
    );

    // --- account-level bindings ---
    const searchResources = yield* ResourceGroups.SearchResources();
    const getAccountSettings = yield* ResourceGroups.GetAccountSettings();
    const listTagSyncTasks = yield* ResourceGroups.ListTagSyncTasks();
    const getTagSyncTask = yield* ResourceGroups.GetTagSyncTask();
    const cancelTagSyncTask = yield* ResourceGroups.CancelTagSyncTask();

    const bound = {
      listGroupResources,
      listGroupingStatuses,
      groupResources,
      ungroupResources,
      startTagSyncTask,
      searchResources,
      getAccountSettings,
      listTagSyncTasks,
      getTagSyncTask,
      cancelTagSyncTask,
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

        // Group-scoped read: the group name is injected from the binding.
        if (request.method === "GET" && pathname === "/members") {
          const { Resources } = yield* listGroupResources();
          return yield* HttpServerResponse.json({
            arns: (Resources ?? []).map((r) => r.Identifier?.ResourceArn),
          });
        }

        // Group-scoped write: the API accepts the request and reports the
        // per-resource outcome (a Lambda ARN is not poolable, so it lands
        // in Failed with a typed error code — proving the full wire loop).
        if (request.method === "POST" && pathname === "/group") {
          const { arn } = (yield* request.json) as { arn: string };
          const out = yield* groupResources({ ResourceArns: [arn] });
          return yield* HttpServerResponse.json({
            succeeded: out.Succeeded ?? [],
            failedCodes: (out.Failed ?? []).map((f) => f.ErrorCode),
            pending: (out.Pending ?? []).map((p) => p.ResourceArn),
          });
        }
        if (request.method === "POST" && pathname === "/ungroup") {
          const { arn } = (yield* request.json) as { arn: string };
          const out = yield* ungroupResources({ ResourceArns: [arn] });
          return yield* HttpServerResponse.json({
            succeeded: out.Succeeded ?? [],
            failedCodes: (out.Failed ?? []).map((f) => f.ErrorCode),
          });
        }

        // Grouping statuses only exist for application groups (which
        // CreateGroup cannot make) — the typed rejection proves the wire.
        if (request.method === "GET" && pathname === "/grouping-statuses") {
          return yield* HttpServerResponse.json(
            yield* tagOf(listGroupingStatuses()),
          );
        }

        // Account-level ad-hoc query.
        if (request.method === "GET" && pathname === "/search") {
          const { ResourceIdentifiers } = yield* searchResources({
            ResourceQuery: {
              Type: "TAG_FILTERS_1_0",
              Query: JSON.stringify({
                ResourceTypeFilters: ["AWS::AllSupported"],
                TagFilters: [
                  { Key: "alchemy::id", Values: ["RGTestFunction"] },
                ],
              }),
            },
          });
          return yield* HttpServerResponse.json({
            arns: (ResourceIdentifiers ?? []).map((r) => r.ResourceArn),
          });
        }

        if (request.method === "GET" && pathname === "/account-settings") {
          const { AccountSettings } = yield* getAccountSettings();
          return yield* HttpServerResponse.json({
            status: AccountSettings?.GroupLifecycleEventsStatus,
          });
        }

        if (request.method === "GET" && pathname === "/tag-sync-tasks") {
          const { TagSyncTasks } = yield* listTagSyncTasks({});
          return yield* HttpServerResponse.json({
            count: (TagSyncTasks ?? []).length,
          });
        }

        // Tag-sync is application-group-only: the typed rejections prove
        // IAM + wiring for the start/get/cancel operations.
        if (request.method === "POST" && pathname === "/start-tag-sync") {
          return yield* HttpServerResponse.json(
            yield* tagOf(
              startTagSyncTask({ TagKey: "alchemy-rg-sync", TagValue: "on" }),
            ),
          );
        }
        if (request.method === "GET" && pathname === "/tag-sync-task") {
          const taskArn = url.searchParams.get("arn") ?? "";
          return yield* HttpServerResponse.json(
            yield* tagOf(getTagSyncTask({ TaskArn: taskArn })),
          );
        }
        if (request.method === "POST" && pathname === "/cancel-tag-sync") {
          const { arn } = (yield* request.json) as { arn: string };
          return yield* HttpServerResponse.json(
            yield* tagOf(cancelTagSyncTask({ TaskArn: arn })),
          );
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
        ResourceGroups.ListGroupResourcesHttp,
        ResourceGroups.ListGroupingStatusesHttp,
        ResourceGroups.GroupResourcesHttp,
        ResourceGroups.UngroupResourcesHttp,
        ResourceGroups.StartTagSyncTaskHttp,
        ResourceGroups.SearchResourcesHttp,
        ResourceGroups.GetAccountSettingsHttp,
        ResourceGroups.ListTagSyncTasksHttp,
        ResourceGroups.GetTagSyncTaskHttp,
        ResourceGroups.CancelTagSyncTaskHttp,
      ),
    ),
  ),
);
