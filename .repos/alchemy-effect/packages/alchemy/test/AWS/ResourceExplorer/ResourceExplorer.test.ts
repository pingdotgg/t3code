import * as AWS from "@/AWS";
import { Index, View } from "@/AWS/ResourceExplorer";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as re2 from "@distilled.cloud/aws/resource-explorer-2";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import ResourceExplorerTestFunctionLive, {
  ResourceExplorerTestFunction,
} from "./handler.ts";

const { test } = Test.make({ providers: AWS.providers() });

// `GetIndex` keeps returning the most recent index long after deletion
// (State DELETED), so both NotFound and DELETING/DELETED mean "no index".
const getLiveIndex = re2.getIndex({}).pipe(
  Effect.map((r): re2.GetIndexOutput | undefined =>
    r.State === "DELETED" || r.State === "DELETING" ? undefined : r,
  ),
  Effect.catchTag("ResourceNotFoundException", () => Effect.succeed(undefined)),
);

// The index is an account/region singleton (capture-and-restore): these
// tests only run destructively when the region has no index, or when the
// existing one carries Alchemy tags (i.e. a leftover from a crashed
// previous run of this same suite). A user-owned index is never touched.
const foreignIndexExists = Effect.gen(function* () {
  const live = yield* getLiveIndex;
  return (
    live !== undefined &&
    !Object.keys(live.Tags ?? {}).some((key) => key.startsWith("alchemy::"))
  );
});

const waitForIndexGone = re2.getIndex({}).pipe(
  Effect.map((r): string | undefined => r.State),
  Effect.catchTag("ResourceNotFoundException", () => Effect.succeed(undefined)),
  Effect.repeat({
    schedule: Schedule.spaced("3 seconds"),
    until: (state) =>
      state === undefined || state === "DELETED" || state === "DELETING",
    times: 20,
  }),
);

const waitForIndexActive = re2.getIndex({}).pipe(
  Effect.repeat({
    schedule: Schedule.spaced("3 seconds"),
    until: (r) => r.State === "ACTIVE",
    times: 30,
  }),
);

const getViewSafe = (viewArn: string) =>
  re2.getView({ ViewArn: viewArn }).pipe(
    Effect.map((r): re2.GetViewOutput | undefined => r),
    // Resource Explorer's "view not found" is the typed UnauthorizedException
    Effect.catchTag(
      ["UnauthorizedException", "ResourceNotFoundException"],
      () => Effect.succeed(undefined),
    ),
  );

// The Resource Explorer index is an account/region singleton, so every
// test in this file mutates the same underlying cloud state — run them
// strictly one at a time (vitest runs tests in a file concurrently by
// default).
describe.sequential("ResourceExplorer", () => {
  test.provider(
    "index lifecycle: create LOCAL, sync tags, promote to AGGREGATOR, destroy",
    (stack) =>
      Effect.gen(function* () {
        if (yield* foreignIndexExists) {
          yield* Effect.logInfo(
            "a foreign Resource Explorer index exists — skipping destructive index lifecycle test",
          );
          return;
        }
        yield* stack.destroy();

        const make = (props: {
          type?: "LOCAL" | "AGGREGATOR";
          tags?: Record<string, string>;
        }) =>
          Effect.gen(function* () {
            const index = yield* Index("Explorer", props);
            return { index };
          });

        // Create — LOCAL index, engine waits for ACTIVE.
        const { index } = yield* stack.deploy(
          make({ tags: { purpose: "alchemy-re2-test" } }),
        );
        expect(index.indexArn).toContain(":index/");
        expect(index.indexType).toBe("LOCAL");
        expect(index.indexState).toBe("ACTIVE");

        // Out-of-band verification: live state + internal & user tags.
        const live = yield* re2.getIndex({});
        expect(live.Arn).toBe(index.indexArn);
        expect(live.State).toBe("ACTIVE");
        expect(live.Tags?.purpose).toBe("alchemy-re2-test");
        expect(live.Tags?.["alchemy::id"]).toBe("Explorer");

        // Canonical list() coverage — the singleton is reported.
        const provider = yield* Provider.findProvider(Index);
        const all = yield* provider.list();
        expect(all.map((i) => i.indexArn)).toContain(index.indexArn);

        // Update — tag sync (add one, drop one) without replacement.
        const { index: retagged } = yield* stack.deploy(
          make({ tags: { team: "platform" } }),
        );
        expect(retagged.indexArn).toBe(index.indexArn);
        const afterTags = yield* re2.getIndex({});
        expect(afterTags.Tags?.team).toBe("platform");
        expect(afterTags.Tags?.purpose).toBeUndefined();
        expect(afterTags.Tags?.["alchemy::id"]).toBe("Explorer");

        // Update — promote to AGGREGATOR in place (single-region account:
        // replication settles quickly). GATED: promoting and then deleting
        // the aggregator index starts an account-wide 24h cool-down on
        // UpdateIndexType (`ServiceQuotaExceededException`, Name
        // "COOL_DOWN_PERIOD"), so the promotion leg cannot run on every CI
        // pass — set AWS_TEST_RE2_AGGREGATOR=1 on a cooled-down account.
        if (process.env.AWS_TEST_RE2_AGGREGATOR) {
          const { index: promoted } = yield* stack.deploy(
            make({ type: "AGGREGATOR", tags: { team: "platform" } }),
          );
          expect(promoted.indexArn).toBe(index.indexArn);
          expect(promoted.indexType).toBe("AGGREGATOR");

          // Let the async promotion settle before deleting.
          const settled = yield* waitForIndexActive;
          expect(settled.Type).toBe("AGGREGATOR");
        }

        // Destroy — Resource Explorer is turned off for the region.
        yield* stack.destroy();
        const gone = yield* waitForIndexGone;
        expect(["DELETED", "DELETING", undefined]).toContain(gone);
      }),
    { timeout: 240_000 },
  );

  test.provider(
    "view lifecycle: single-shot deploy with index, update filters, replace on rename",
    (stack) =>
      Effect.gen(function* () {
        if (yield* foreignIndexExists) {
          yield* Effect.logInfo(
            "a foreign Resource Explorer index exists — skipping destructive view lifecycle test",
          );
          return;
        }
        yield* stack.destroy();

        const make = (props: {
          viewName?: string;
          filterString?: string;
          includedProperties?: string[];
        }) =>
          Effect.gen(function* () {
            // Index + View in ONE deploy: the view provider retries
            // through the index's provisioning window.
            const index = yield* Index("Explorer", {});
            const view = yield* View("TestView", props);
            return { index, view };
          });

        // Create — filtered view with tags included in results.
        const { index, view } = yield* stack.deploy(
          make({
            filterString: "service:s3",
            includedProperties: ["tags"],
          }),
        );
        expect(index.indexState).toBe("ACTIVE");
        expect(view.viewArn).toContain(":view/");
        expect(view.scope).toBeDefined();

        const observed = yield* re2.getView({ ViewArn: view.viewArn });
        expect(observed.View?.Filters?.FilterString).toBe("service:s3");
        expect(observed.View?.IncludedProperties).toEqual([{ Name: "tags" }]);
        expect(observed.Tags?.["alchemy::id"]).toBe("TestView");

        // Update — change the filter and clear included properties
        // (UpdateView replaces both).
        const { view: updated } = yield* stack.deploy(
          make({ filterString: "service:sqs" }),
        );
        expect(updated.viewArn).toBe(view.viewArn);
        const afterUpdate = yield* re2.getView({ ViewArn: view.viewArn });
        expect(afterUpdate.View?.Filters?.FilterString).toBe("service:sqs");
        expect(afterUpdate.View?.IncludedProperties ?? []).toEqual([]);

        // Canonical list() coverage.
        const provider = yield* Provider.findProvider(View);
        const all = yield* provider.list();
        expect(all.map((v) => v.viewArn)).toContain(view.viewArn);

        // Replace — an explicit rename replaces the view (the index stays
        // deployed across the replacement).
        const { view: renamed } = yield* stack.deploy(
          make({
            viewName: "alchemy-re2-renamed-view",
            filterString: "service:sqs",
          }),
        );
        expect(renamed.viewArn).not.toBe(view.viewArn);
        expect(renamed.viewName).toBe("alchemy-re2-renamed-view");
        // Old view is gone after the replacement completes.
        const oldView = yield* getViewSafe(view.viewArn);
        expect(oldView).toBeUndefined();

        // Destroy — the view and the index are removed.
        yield* stack.destroy();
        const goneView = yield* getViewSafe(renamed.viewArn);
        expect(goneView).toBeUndefined();
        const goneIndex = yield* waitForIndexGone;
        expect(["DELETED", "DELETING", undefined]).toContain(goneIndex);
      }),
    { timeout: 240_000 },
  );

  describe("Bindings", () => {
    test.provider(
      "deployed Lambda exercises Search, ListResources and ListSupportedResourceTypes",
      (stack) =>
        Effect.gen(function* () {
          if (yield* foreignIndexExists) {
            yield* Effect.logInfo(
              "a foreign Resource Explorer index exists — skipping search binding test",
            );
            return;
          }
          yield* stack.destroy();

          const { functionUrl } = yield* stack.deploy(
            Effect.gen(function* () {
              return yield* ResourceExplorerTestFunction;
            }).pipe(Effect.provide(ResourceExplorerTestFunctionLive)),
          );
          expect(functionUrl).toBeTruthy();
          const baseUrl = functionUrl!.replace(/\/+$/, "");

          const client = yield* HttpClient.HttpClient;
          // Fresh function URLs take a few seconds to start serving; 403/
          // 5xx during that window are transient.
          const response = yield* client
            .get(`${baseUrl}/search?q=service:s3`)
            .pipe(
              Effect.flatMap((res) =>
                res.status === 200
                  ? Effect.succeed(res)
                  : Effect.fail(new Error(`status ${res.status}`)),
              ),
              Effect.retry({
                schedule: Schedule.max([
                  Schedule.fixed("3 seconds"),
                  Schedule.recurs(40),
                ]),
              }),
            );
          const body = (yield* response.json) as {
            viewArn: string;
            totalResources: number;
            complete: boolean;
            resources: string[];
          };
          // A brand-new index may not have indexed anything yet — assert
          // the search round-trip itself, not its contents.
          expect(body.viewArn).toContain(":view/");
          expect(typeof body.totalResources).toBe("number");
          expect(Array.isArray(body.resources)).toBe(true);

          // ListResources — structured-filter enumeration through the same
          // view (a brand-new index may be empty; assert the round-trip).
          const listRes = yield* client.get(
            `${baseUrl}/resources?filter=service:s3`,
          );
          expect(listRes.status).toBe(200);
          const listBody = (yield* listRes.json) as {
            viewArn: string;
            resources: string[];
          };
          expect(listBody.viewArn).toContain(":view/");
          expect(Array.isArray(listBody.resources)).toBe(true);

          // ListSupportedResourceTypes — account-level discovery; always
          // returns a non-empty catalog.
          const typesRes = yield* client.get(`${baseUrl}/types`);
          expect(typesRes.status).toBe(200);
          const typesBody = (yield* typesRes.json) as {
            resourceTypes: string[];
          };
          expect(typesBody.resourceTypes.length).toBeGreaterThan(0);

          yield* stack.destroy();
          const goneIndex = yield* waitForIndexGone;
          expect(["DELETED", "DELETING", undefined]).toContain(goneIndex);
        }),
      { timeout: 300_000 },
    );
  });
});
