import * as Lambda from "@/AWS/Lambda";
import * as ServiceCatalog from "@/AWS/ServiceCatalog";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

/**
 * Well-formed identifiers that cannot exist — drive the typed not-found
 * paths for the service-action and StackSet bindings (whose live setup
 * needs an SSM-backed service action / StackSet product), proving the
 * grants reach the API: an IAM gap would surface AccessDeniedException
 * (an untyped defect) instead of the typed tag.
 */
const FAKE_PROVISIONED_PRODUCT_ID = "pp-aaaaaaaaaaaaa";
const FAKE_SERVICE_ACTION_ID = "act-aaaaaaaaaaaaa";

export class ServiceCatalogTestFunction extends Lambda.Function<Lambda.Function>()(
  "ServiceCatalogTestFunction",
) {}

export default ServiceCatalogTestFunction.make(
  {
    main,
    url: true,
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    const searchProducts = yield* ServiceCatalog.SearchProducts();
    const describeProduct = yield* ServiceCatalog.DescribeProduct();
    const listLaunchPaths = yield* ServiceCatalog.ListLaunchPaths();
    const describeProvisioningParameters =
      yield* ServiceCatalog.DescribeProvisioningParameters();
    const provisionProduct = yield* ServiceCatalog.ProvisionProduct();
    const updateProvisionedProduct =
      yield* ServiceCatalog.UpdateProvisionedProduct();
    const terminateProvisionedProduct =
      yield* ServiceCatalog.TerminateProvisionedProduct();
    const describeProvisionedProduct =
      yield* ServiceCatalog.DescribeProvisionedProduct();
    const searchProvisionedProducts =
      yield* ServiceCatalog.SearchProvisionedProducts();
    const describeRecord = yield* ServiceCatalog.DescribeRecord();
    const listRecordHistory = yield* ServiceCatalog.ListRecordHistory();
    const getProvisionedProductOutputs =
      yield* ServiceCatalog.GetProvisionedProductOutputs();
    const listStackInstancesForProvisionedProduct =
      yield* ServiceCatalog.ListStackInstancesForProvisionedProduct();
    const executeProvisionedProductServiceAction =
      yield* ServiceCatalog.ExecuteProvisionedProductServiceAction();
    const describeServiceActionExecutionParameters =
      yield* ServiceCatalog.DescribeServiceActionExecutionParameters();

    const bound = {
      searchProducts,
      describeProduct,
      listLaunchPaths,
      describeProvisioningParameters,
      provisionProduct,
      updateProvisionedProduct,
      terminateProvisionedProduct,
      describeProvisionedProduct,
      searchProvisionedProducts,
      describeRecord,
      listRecordHistory,
      getProvisionedProductOutputs,
      listStackInstancesForProvisionedProduct,
      executeProvisionedProductServiceAction,
      describeServiceActionExecutionParameters,
    };

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;
        const q = (name: string) => url.searchParams.get(name) ?? undefined;

        if (pathname === "/bindings") {
          return yield* HttpServerResponse.json({ bound: Object.keys(bound) });
        }

        // IAM policy propagation on the freshly attached binding grants can
        // lag the deploy — surface the typed AccessDeniedException as a tag
        // so the test's bounded polls ride it out instead of exhausting the
        // 5xx retry budget.
        if (pathname === "/search") {
          const result = yield* searchProducts().pipe(
            Effect.map((r) => ({
              tag: "Ok" as string,
              count: (r.ProductViewSummaries ?? []).length,
              productIds: (r.ProductViewSummaries ?? []).map(
                (p) => p.ProductId,
              ),
            })),
            Effect.catchTag(
              ["InvalidParametersException", "AccessDeniedException"],
              (e) => Effect.succeed({ tag: e._tag as string, count: -1 }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (pathname === "/product") {
          const result = yield* describeProduct({ Id: q("id") }).pipe(
            Effect.map((r) => ({
              tag: "Ok" as string,
              name: r.ProductViewSummary?.Name,
            })),
            Effect.catchTag(
              [
                "ResourceNotFoundException",
                "InvalidParametersException",
                "AccessDeniedException",
              ],
              (e) => Effect.succeed({ tag: e._tag as string, name: undefined }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (pathname === "/launch-paths") {
          const result = yield* listLaunchPaths({
            ProductId: q("productId")!,
          }).pipe(
            Effect.map((r) => ({
              tag: "Ok" as string,
              count: (r.LaunchPathSummaries ?? []).length,
              pathId: r.LaunchPathSummaries?.[0]?.Id,
            })),
            Effect.catchTag(
              [
                "ResourceNotFoundException",
                "InvalidParametersException",
                "AccessDeniedException",
              ],
              (e) =>
                Effect.succeed({
                  tag: e._tag as string,
                  count: 0,
                  pathId: undefined,
                }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (pathname === "/params") {
          const result = yield* describeProvisioningParameters({
            ProductId: q("productId"),
            ProvisioningArtifactId: q("artifactId"),
            PathId: q("pathId"),
          }).pipe(
            Effect.map((r) => ({
              tag: "Ok" as string,
              count: (r.ProvisioningArtifactParameters ?? []).length,
            })),
            Effect.catchTag(
              [
                "ResourceNotFoundException",
                "InvalidParametersException",
                "AccessDeniedException",
              ],
              (e) => Effect.succeed({ tag: e._tag as string, count: 0 }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (pathname === "/provision") {
          const result = yield* provisionProduct({
            ProductId: q("productId")!,
            ProvisioningArtifactId: q("artifactId")!,
            PathId: q("pathId"),
            ProvisionedProductName: q("name")!,
            ProvisionToken: q("token")!,
          }).pipe(
            Effect.map((r) => ({
              tag: "Ok" as string,
              recordId: r.RecordDetail?.RecordId,
              provisionedProductId: r.RecordDetail?.ProvisionedProductId,
              status: r.RecordDetail?.Status,
            })),
            Effect.catchTag(
              [
                "ResourceNotFoundException",
                "InvalidParametersException",
                "DuplicateResourceException",
                "AccessDeniedException",
              ],
              (e) => Effect.succeed({ tag: e._tag as string }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (pathname === "/record") {
          const result = yield* describeRecord({ Id: q("id")! }).pipe(
            Effect.map((r) => ({
              tag: "Ok" as string,
              status: r.RecordDetail?.Status,
              errors: (r.RecordDetail?.RecordErrors ?? []).map(
                (e) => e.Description,
              ),
            })),
            Effect.catchTag(
              ["ResourceNotFoundException", "AccessDeniedException"],
              (e) => Effect.succeed({ tag: e._tag as string }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (pathname === "/pp") {
          const result = yield* describeProvisionedProduct({
            Name: q("name"),
          }).pipe(
            Effect.map((r) => ({
              tag: "Ok" as string,
              status: r.ProvisionedProductDetail?.Status,
              provisionedProductId: r.ProvisionedProductDetail?.Id,
              lastRecordId: r.ProvisionedProductDetail?.LastRecordId,
            })),
            Effect.catchTag(
              [
                "ResourceNotFoundException",
                "InvalidParametersException",
                "AccessDeniedException",
              ],
              (e) => Effect.succeed({ tag: e._tag as string }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (pathname === "/search-pp") {
          const result = yield* searchProvisionedProducts().pipe(
            Effect.map((r) => ({
              tag: "Ok" as string,
              count: (r.ProvisionedProducts ?? []).length,
            })),
            Effect.catchTag(
              ["InvalidParametersException", "AccessDeniedException"],
              (e) => Effect.succeed({ tag: e._tag as string, count: -1 }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (pathname === "/history") {
          const result = yield* listRecordHistory().pipe(
            Effect.map((r) => ({
              tag: "Ok" as string,
              count: (r.RecordDetails ?? []).length,
            })),
            Effect.catchTag(
              ["InvalidParametersException", "AccessDeniedException"],
              (e) => Effect.succeed({ tag: e._tag as string, count: -1 }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (pathname === "/outputs") {
          const result = yield* getProvisionedProductOutputs({
            ProvisionedProductName: q("name"),
          }).pipe(
            Effect.map((r) => ({
              tag: "Ok" as string,
              count: (r.Outputs ?? []).length,
            })),
            Effect.catchTag(
              [
                "ResourceNotFoundException",
                "InvalidParametersException",
                "AccessDeniedException",
              ],
              (e) => Effect.succeed({ tag: e._tag as string, count: 0 }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (pathname === "/terminate") {
          const result = yield* terminateProvisionedProduct({
            ProvisionedProductName: q("name"),
            TerminateToken: q("token")!,
          }).pipe(
            Effect.map((r) => ({
              tag: "Ok" as string,
              recordId: r.RecordDetail?.RecordId,
            })),
            Effect.catchTag(
              ["ResourceNotFoundException", "AccessDeniedException"],
              (e) =>
                Effect.succeed({ tag: e._tag as string, recordId: undefined }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (pathname === "/update-nonexistent") {
          // Typed not-found — proves the UpdateProvisionedProduct grant
          // reaches the API without mutating anything real.
          const result = yield* updateProvisionedProduct({
            ProvisionedProductName: "alchemy-sc-does-not-exist",
            UpdateToken: "alchemyscupdateprobe",
          }).pipe(
            Effect.map(() => "Ok"),
            Effect.catchTag(
              ["ResourceNotFoundException", "InvalidParametersException"],
              (e) => Effect.succeed(e._tag),
            ),
          );
          return yield* HttpServerResponse.json({ tag: result });
        }

        if (pathname === "/stack-instances-nonexistent") {
          const result = yield* listStackInstancesForProvisionedProduct({
            ProvisionedProductId: FAKE_PROVISIONED_PRODUCT_ID,
          }).pipe(
            Effect.map(() => "Ok"),
            Effect.catchTag(
              ["ResourceNotFoundException", "InvalidParametersException"],
              (e) => Effect.succeed(e._tag),
            ),
          );
          return yield* HttpServerResponse.json({ tag: result });
        }

        if (pathname === "/service-action-params-nonexistent") {
          const result = yield* describeServiceActionExecutionParameters({
            ProvisionedProductId: FAKE_PROVISIONED_PRODUCT_ID,
            ServiceActionId: FAKE_SERVICE_ACTION_ID,
          }).pipe(
            Effect.map(() => "Ok"),
            Effect.catchTag(
              ["ResourceNotFoundException", "InvalidParametersException"],
              (e) => Effect.succeed(e._tag),
            ),
          );
          return yield* HttpServerResponse.json({ tag: result });
        }

        if (pathname === "/execute-nonexistent") {
          // Service Catalog misuses ValidationException for a missing
          // provisioned product on this op — distilled remaps it to the
          // synthetic ProvisionedProductNotFound tag
          // (patches/service-catalog.json). ValidationException (a typed
          // CommonErrors member) is also caught so the probe works against
          // a distilled lib built before the patch.
          const result = yield* executeProvisionedProductServiceAction({
            ProvisionedProductId: FAKE_PROVISIONED_PRODUCT_ID,
            ServiceActionId: FAKE_SERVICE_ACTION_ID,
            ExecuteToken: "alchemyscexecuteprobe",
          }).pipe(
            Effect.map(() => "Ok"),
            Effect.catchTag(
              [
                "ProvisionedProductNotFound",
                "ValidationException",
                "ResourceNotFoundException",
                "InvalidParametersException",
                "InvalidStateException",
              ],
              (e) => Effect.succeed(e._tag),
            ),
          );
          return yield* HttpServerResponse.json({ tag: result });
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
        ServiceCatalog.SearchProductsHttp,
        ServiceCatalog.DescribeProductHttp,
        ServiceCatalog.ListLaunchPathsHttp,
        ServiceCatalog.DescribeProvisioningParametersHttp,
        ServiceCatalog.ProvisionProductHttp,
        ServiceCatalog.UpdateProvisionedProductHttp,
        ServiceCatalog.TerminateProvisionedProductHttp,
        ServiceCatalog.DescribeProvisionedProductHttp,
        ServiceCatalog.SearchProvisionedProductsHttp,
        ServiceCatalog.DescribeRecordHttp,
        ServiceCatalog.ListRecordHistoryHttp,
        ServiceCatalog.GetProvisionedProductOutputsHttp,
        ServiceCatalog.ListStackInstancesForProvisionedProductHttp,
        ServiceCatalog.ExecuteProvisionedProductServiceActionHttp,
        ServiceCatalog.DescribeServiceActionExecutionParametersHttp,
      ),
    ),
  ),
);
