import * as DirectoryService from "@/AWS/DirectoryService";
import * as Lambda from "@/AWS/Lambda";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

export class DirectoryServiceTestFunction extends Lambda.Function<Lambda.Function>()(
  "DirectoryServiceTestFunction",
) {}

export default DirectoryServiceTestFunction.make(
  {
    main,
    url: true,
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    // Account-level capabilities — no directory required, so the fixture
    // deploys in seconds. (Directory-scoped capabilities bind to a live
    // directory, which takes ~10 minutes to provision; they share the same
    // scaffolding and are exercised by the gated lifecycle tests.)
    const getDirectoryLimits = yield* DirectoryService.GetDirectoryLimits();
    const describeDirectories = yield* DirectoryService.DescribeDirectories();

    const bound = { getDirectoryLimits, describeDirectories };

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

        // Account limits: the response always carries the cloud directory
        // counters for the region.
        if (request.method === "GET" && pathname === "/limits") {
          const { DirectoryLimits } = yield* getDirectoryLimits();
          return yield* HttpServerResponse.json({
            cloudOnlyLimit: DirectoryLimits?.CloudOnlyDirectoriesLimit,
            cloudOnlyCount: DirectoryLimits?.CloudOnlyDirectoriesCurrentCount,
          });
        }

        // Account-wide directory enumeration (empty in a clean account).
        if (request.method === "GET" && pathname === "/directories") {
          const { DirectoryDescriptions } = yield* describeDirectories();
          return yield* HttpServerResponse.json({
            ids: (DirectoryDescriptions ?? []).map(
              (directory) => directory.DirectoryId,
            ),
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
        DirectoryService.GetDirectoryLimitsHttp,
        DirectoryService.DescribeDirectoriesHttp,
      ),
    ),
  ),
);
