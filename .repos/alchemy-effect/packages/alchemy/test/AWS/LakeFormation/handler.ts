import * as Glue from "@/AWS/Glue";
import * as LakeFormation from "@/AWS/LakeFormation";
import * as Lambda from "@/AWS/Lambda";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

/**
 * Deterministic fixture names — the handler needs the database name at
 * runtime, so it is a constant shared by deploy time and runtime.
 */
export const FIXTURE_DATABASE = "alchemy_lf_bindings_fixture";

/** A tag key that never exists — drives the typed EntityNotFound paths. */
const MISSING_TAG_KEY = "alchemy-lf-bindings-missing";

export class LakeFormationTestFunction extends Lambda.Function<Lambda.Function>()(
  "LakeFormationTestFunction",
) {}

export default LakeFormationTestFunction.make(
  {
    main,
    url: true,
    // Lake Formation calls routinely take a few seconds; the default 3s
    // Lambda timeout is too tight.
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    // A database for GetResourceLFTags to observe (deterministic name so
    // the runtime routes can reference it).
    yield* Glue.Database("LfBindingsDb", {
      databaseName: FIXTURE_DATABASE,
    });

    // --- account-level bindings ---
    const getDataLakePrincipal = yield* LakeFormation.GetDataLakePrincipal();
    const getTemporaryGlueTableCredentials =
      yield* LakeFormation.GetTemporaryGlueTableCredentials();
    const getTemporaryGluePartitionCredentials =
      yield* LakeFormation.GetTemporaryGluePartitionCredentials();
    const getTemporaryDataLocationCredentials =
      yield* LakeFormation.GetTemporaryDataLocationCredentials();
    const searchDatabasesByLFTags =
      yield* LakeFormation.SearchDatabasesByLFTags();
    const searchTablesByLFTags = yield* LakeFormation.SearchTablesByLFTags();
    const getResourceLFTags = yield* LakeFormation.GetResourceLFTags();
    const getEffectivePermissionsForPath =
      yield* LakeFormation.GetEffectivePermissionsForPath();
    const getLFTag = yield* LakeFormation.GetLFTag();
    const listLFTags = yield* LakeFormation.ListLFTags();
    const listPermissions = yield* LakeFormation.ListPermissions();

    const bound = {
      getDataLakePrincipal,
      getTemporaryGlueTableCredentials,
      getTemporaryGluePartitionCredentials,
      getTemporaryDataLocationCredentials,
      searchDatabasesByLFTags,
      searchTablesByLFTags,
      getResourceLFTags,
      getEffectivePermissionsForPath,
      getLFTag,
      listLFTags,
      listPermissions,
    };

    // A syntactically valid, foreign-account Glue table ARN — the credential
    // vending probes prove the IAM grant reaches the API by observing a
    // *typed* Lake Formation rejection rather than an IAM signature failure.
    const foreignTableArn = Effect.sync(
      () =>
        `arn:aws:glue:${process.env.AWS_REGION}:123456789012:table/missing_db/missing_table`,
    );

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

        if (request.method === "GET" && pathname === "/principal") {
          const result = yield* getDataLakePrincipal().pipe(
            Effect.map((r) => ({ tag: "Ok", identity: r.Identity ?? null })),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "GET" && pathname === "/tags") {
          const result = yield* listLFTags().pipe(
            Effect.map((r) => ({ tag: "Ok", count: (r.LFTags ?? []).length })),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "GET" && pathname === "/tag-missing") {
          const result = yield* getLFTag({ TagKey: MISSING_TAG_KEY }).pipe(
            Effect.map(() => ({ tag: "Ok" })),
            Effect.catchTag(
              ["EntityNotFoundException", "AccessDeniedException"],
              (e) => Effect.succeed({ tag: e._tag }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "GET" && pathname === "/permissions") {
          const result = yield* listPermissions().pipe(
            Effect.map((r) => ({
              tag: "Ok",
              count: (r.PrincipalResourcePermissions ?? []).length,
            })),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "GET" && pathname === "/search-databases") {
          const result = yield* searchDatabasesByLFTags({
            Expression: [{ TagKey: MISSING_TAG_KEY, TagValues: ["x"] }],
          }).pipe(
            Effect.map((r) => ({
              tag: "Ok",
              count: (r.DatabaseList ?? []).length,
            })),
            Effect.catchTag(
              ["EntityNotFoundException", "AccessDeniedException"],
              (e) => Effect.succeed({ tag: e._tag, count: 0 }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "GET" && pathname === "/search-tables") {
          const result = yield* searchTablesByLFTags({
            Expression: [{ TagKey: MISSING_TAG_KEY, TagValues: ["x"] }],
          }).pipe(
            Effect.map((r) => ({
              tag: "Ok",
              count: (r.TableList ?? []).length,
            })),
            Effect.catchTag(
              ["EntityNotFoundException", "AccessDeniedException"],
              (e) => Effect.succeed({ tag: e._tag, count: 0 }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "GET" && pathname === "/resource-tags") {
          const result = yield* getResourceLFTags({
            Resource: { Database: { Name: FIXTURE_DATABASE } },
          }).pipe(
            Effect.map((r) => ({
              tag: "Ok",
              count: (r.LFTagOnDatabase ?? []).length,
            })),
            Effect.catchTag(
              [
                "EntityNotFoundException",
                "AccessDeniedException",
                "GlueEncryptionException",
              ],
              (e) => Effect.succeed({ tag: e._tag, count: 0 }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "GET" && pathname === "/effective-permissions") {
          const result = yield* getEffectivePermissionsForPath({
            ResourceArn: "arn:aws:s3:::alchemy-lf-bindings-nonexistent",
          }).pipe(
            Effect.map((r) => ({
              tag: "Ok",
              count: (r.Permissions ?? []).length,
            })),
            Effect.catchTag(
              ["EntityNotFoundException", "InvalidInputException"],
              (e) => Effect.succeed({ tag: e._tag, count: 0 }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "GET" && pathname === "/table-credentials") {
          const TableArn = yield* foreignTableArn;
          const result = yield* getTemporaryGlueTableCredentials({
            TableArn,
            Permissions: ["SELECT"],
            SupportedPermissionTypes: ["COLUMN_PERMISSION"],
          }).pipe(
            Effect.map(() => ({ tag: "Ok" })),
            Effect.catchTag(
              [
                "AccessDeniedException",
                "EntityNotFoundException",
                "InvalidInputException",
                "PermissionTypeMismatchException",
              ],
              (e) => Effect.succeed({ tag: e._tag }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "GET" && pathname === "/partition-credentials") {
          const TableArn = yield* foreignTableArn;
          const result = yield* getTemporaryGluePartitionCredentials({
            TableArn,
            Partition: { Values: ["x"] },
            Permissions: ["SELECT"],
          }).pipe(
            Effect.map(() => ({ tag: "Ok" })),
            Effect.catchTag(
              [
                "AccessDeniedException",
                "EntityNotFoundException",
                "InvalidInputException",
                "PermissionTypeMismatchException",
              ],
              (e) => Effect.succeed({ tag: e._tag }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "GET" && pathname === "/location-credentials") {
          const result = yield* getTemporaryDataLocationCredentials({
            DataLocations: ["arn:aws:s3:::alchemy-lf-bindings-nonexistent"],
            CredentialsScope: "READ",
          }).pipe(
            Effect.map(() => ({ tag: "Ok" })),
            Effect.catchTag(
              [
                "AccessDeniedException",
                "EntityNotFoundException",
                "InvalidInputException",
                "ConflictException",
              ],
              (e) => Effect.succeed({ tag: e._tag }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        return yield* HttpServerResponse.json(
          { error: "not found" },
          { status: 404 },
        );
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        LakeFormation.GetDataLakePrincipalHttp,
        LakeFormation.GetTemporaryGlueTableCredentialsHttp,
        LakeFormation.GetTemporaryGluePartitionCredentialsHttp,
        LakeFormation.GetTemporaryDataLocationCredentialsHttp,
        LakeFormation.SearchDatabasesByLFTagsHttp,
        LakeFormation.SearchTablesByLFTagsHttp,
        LakeFormation.GetResourceLFTagsHttp,
        LakeFormation.GetEffectivePermissionsForPathHttp,
        LakeFormation.GetLFTagHttp,
        LakeFormation.ListLFTagsHttp,
        LakeFormation.ListPermissionsHttp,
      ),
    ),
  ),
);
