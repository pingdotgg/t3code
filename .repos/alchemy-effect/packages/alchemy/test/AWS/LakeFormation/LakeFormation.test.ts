import * as AWS from "@/AWS";
import * as Test from "@/Test/Alchemy";
import * as iam from "@distilled.cloud/aws/iam";
import * as lf from "@distilled.cloud/aws/lakeformation";
import * as sts from "@distilled.cloud/aws/sts";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

const { test } = Test.make({ providers: AWS.providers() });

/**
 * LF-tag operations and permission grants require the caller to be a data
 * lake administrator. Each stack bootstraps the caller as admin via
 * `DataLakeSettings` (managed additively + restored on destroy). Derive the
 * caller's IAM role ARN (with path — `GetRole` returns it, the assumed-role
 * STS ARN does not carry the path).
 */
const callerPrincipalArn = Effect.gen(function* () {
  const identity = yield* sts.getCallerIdentity({});
  const arn = identity.Arn!;
  const match = /assumed-role\/([^/]+)\//.exec(arn);
  if (match === null) return arn;
  const role = yield* iam.getRole({ RoleName: match[1]! });
  return role.Role.Arn;
});

const adminIds = Effect.gen(function* () {
  const settings = (yield* lf.getDataLakeSettings({})).DataLakeSettings ?? {};
  return (settings.DataLakeAdmins ?? [])
    .map((p) => p.DataLakePrincipalIdentifier)
    .filter((id): id is string => id !== undefined);
});

/** Raw (unfiltered) permission entries a principal holds on a database. */
const principalDatabasePermissions = (
  principal: string,
  databaseName: string,
) =>
  Effect.gen(function* () {
    const pages = yield* lf.listPermissions
      .pages({ Resource: { Database: { Name: databaseName } } })
      .pipe(Stream.runCollect);
    return Array.from(pages)
      .flatMap((p) => p.PrincipalResourcePermissions ?? [])
      .filter((e) => e.Principal?.DataLakePrincipalIdentifier === principal)
      .flatMap((e) => e.Permissions ?? [])
      .sort();
  });

const trustPolicy: AWS.IAM.PolicyDocument = {
  Version: "2012-10-17",
  Statement: [
    {
      Effect: "Allow",
      Principal: { Service: "glue.amazonaws.com" },
      Action: ["sts:AssumeRole"],
    },
  ],
};

// All three tests mutate the account-level DataLakeSettings singleton
// (adding the caller / a scratch role as admin) — run them sequentially so
// concurrent read-modify-write cycles cannot clobber each other.
describe.sequential("LakeFormation", () => {
  test.provider(
    "DataLakeSettings adds admins additively and restores on destroy",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const beforeAdmins = yield* adminIds;

        const created = yield* stack.deploy(
          Effect.gen(function* () {
            const role = yield* AWS.IAM.Role("LfAdminRole", {
              assumeRolePolicyDocument: trustPolicy,
            });
            const settings = yield* AWS.LakeFormation.DataLakeSettings(
              "Settings",
              { dataLakeAdmins: [role.roleArn] },
            );
            return { role, settings };
          }),
        );

        expect(created.settings.catalogId).toBeDefined();
        expect(created.settings.dataLakeAdmins).toContain(created.role.roleArn);
        expect(created.settings.managedAdmins).toEqual([created.role.roleArn]);

        // out-of-band: our admin was added, pre-existing admins survived
        const duringAdmins = yield* adminIds;
        expect(duringAdmins).toContain(created.role.roleArn);
        for (const admin of beforeAdmins) {
          expect(duringAdmins).toContain(admin);
        }

        // destroy — only the admin we added is removed
        yield* stack.destroy();
        const afterAdmins = yield* adminIds;
        expect(afterAdmins).not.toContain(created.role.roleArn);
        for (const admin of beforeAdmins) {
          expect(afterAdmins).toContain(admin);
        }
      }),
    { timeout: 180_000 },
  );

  test.provider(
    "Permissions grants, updates, and revokes on a Glue database",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const admin = yield* callerPrincipalArn;

        const created = yield* stack.deploy(
          Effect.gen(function* () {
            const settings = yield* AWS.LakeFormation.DataLakeSettings(
              "Admin",
              { dataLakeAdmins: [admin] },
            );
            const database = yield* AWS.Glue.Database("LfDb", {});
            const role = yield* AWS.IAM.Role("LfAnalyst", {
              assumeRolePolicyDocument: trustPolicy,
            });
            const grant = yield* AWS.LakeFormation.Permissions("AnalystDb", {
              // consume a settings output so admin bootstrap deploys first
              // and is destroyed last
              catalogId: settings.catalogId,
              principal: role.roleArn,
              resource: { database: { name: database.databaseName } },
              permissions: ["CREATE_TABLE", "DESCRIBE"],
            });
            return { settings, database, role, grant };
          }),
        );

        expect(created.grant.permissions).toEqual(["CREATE_TABLE", "DESCRIBE"]);
        expect(created.grant.resource.Database?.Name).toEqual(
          created.database.databaseName,
        );

        // out-of-band verification (raw entries, not principal-filtered)
        const observed = yield* principalDatabasePermissions(
          created.role.roleArn,
          created.database.databaseName,
        );
        expect(observed).toEqual(["CREATE_TABLE", "DESCRIBE"]);

        // update — swap CREATE_TABLE for ALTER (grant + revoke delta)
        const updated = yield* stack.deploy(
          Effect.gen(function* () {
            const settings = yield* AWS.LakeFormation.DataLakeSettings(
              "Admin",
              { dataLakeAdmins: [admin] },
            );
            const database = yield* AWS.Glue.Database("LfDb", {});
            const role = yield* AWS.IAM.Role("LfAnalyst", {
              assumeRolePolicyDocument: trustPolicy,
            });
            const grant = yield* AWS.LakeFormation.Permissions("AnalystDb", {
              catalogId: settings.catalogId,
              principal: role.roleArn,
              resource: { database: { name: database.databaseName } },
              permissions: ["ALTER", "DESCRIBE"],
            });
            return { settings, database, role, grant };
          }),
        );

        expect(updated.grant.permissions).toEqual(["ALTER", "DESCRIBE"]);
        const reobserved = yield* principalDatabasePermissions(
          created.role.roleArn,
          created.database.databaseName,
        );
        expect(reobserved).toEqual(["ALTER", "DESCRIBE"]);

        // remove the grant from the stack — permissions are revoked while
        // the database still exists, so we can verify out-of-band
        yield* stack.deploy(
          Effect.gen(function* () {
            const settings = yield* AWS.LakeFormation.DataLakeSettings(
              "Admin",
              { dataLakeAdmins: [admin] },
            );
            const database = yield* AWS.Glue.Database("LfDb", {});
            const role = yield* AWS.IAM.Role("LfAnalyst", {
              assumeRolePolicyDocument: trustPolicy,
            });
            return { settings, database, role };
          }),
        );

        const revoked = yield* principalDatabasePermissions(
          created.role.roleArn,
          created.database.databaseName,
        );
        expect(revoked).toEqual([]);

        yield* stack.destroy();
      }),
    { timeout: 240_000 },
  );

  test.provider(
    "LFTag lifecycle and LFTagAssociation on a Glue database",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const admin = yield* callerPrincipalArn;

        const created = yield* stack.deploy(
          Effect.gen(function* () {
            const settings = yield* AWS.LakeFormation.DataLakeSettings(
              "Admin",
              { dataLakeAdmins: [admin] },
            );
            const tag = yield* AWS.LakeFormation.LFTag("EnvTag", {
              catalogId: settings.catalogId,
              tagKey: "alchemy-lf-env",
              tagValues: ["dev", "prod"],
            });
            const database = yield* AWS.Glue.Database("LfTagDb", {});
            const association = yield* AWS.LakeFormation.LFTagAssociation(
              "DbEnv",
              {
                catalogId: settings.catalogId,
                resource: { database: { name: database.databaseName } },
                lfTags: [{ tagKey: tag.tagKey, tagValues: ["dev"] }],
              },
            );
            return { settings, tag, database, association };
          }),
        );

        expect(created.tag.tagKey).toEqual("alchemy-lf-env");
        expect([...created.tag.tagValues].sort()).toEqual(["dev", "prod"]);

        // out-of-band: tag definition + assignment on the database
        const observedTag = yield* lf.getLFTag({ TagKey: "alchemy-lf-env" });
        expect([...(observedTag.TagValues ?? [])].sort()).toEqual([
          "dev",
          "prod",
        ]);
        const observedAssignment = yield* lf.getResourceLFTags({
          Resource: {
            Database: { Name: created.database.databaseName },
          },
        });
        expect(
          observedAssignment.LFTagOnDatabase?.find(
            (t) => t.TagKey === "alchemy-lf-env",
          )?.TagValues,
        ).toEqual(["dev"]);

        // update — add a tag value and move the assignment onto it
        yield* stack.deploy(
          Effect.gen(function* () {
            const settings = yield* AWS.LakeFormation.DataLakeSettings(
              "Admin",
              { dataLakeAdmins: [admin] },
            );
            const tag = yield* AWS.LakeFormation.LFTag("EnvTag", {
              catalogId: settings.catalogId,
              tagKey: "alchemy-lf-env",
              tagValues: ["dev", "prod", "staging"],
            });
            const database = yield* AWS.Glue.Database("LfTagDb", {});
            const association = yield* AWS.LakeFormation.LFTagAssociation(
              "DbEnv",
              {
                catalogId: settings.catalogId,
                resource: { database: { name: database.databaseName } },
                lfTags: [{ tagKey: tag.tagKey, tagValues: ["staging"] }],
              },
            );
            return { settings, tag, database, association };
          }),
        );

        const updatedTag = yield* lf.getLFTag({ TagKey: "alchemy-lf-env" });
        expect([...(updatedTag.TagValues ?? [])].sort()).toEqual([
          "dev",
          "prod",
          "staging",
        ]);
        const updatedAssignment = yield* lf.getResourceLFTags({
          Resource: {
            Database: { Name: created.database.databaseName },
          },
        });
        expect(
          updatedAssignment.LFTagOnDatabase?.find(
            (t) => t.TagKey === "alchemy-lf-env",
          )?.TagValues,
        ).toEqual(["staging"]);

        // remove tag + association from the stack (settings stay, so the
        // caller is still admin and can verify the deletion out-of-band —
        // GetLFTag as a non-admin is AccessDenied, not EntityNotFound)
        yield* stack.deploy(
          Effect.gen(function* () {
            const settings = yield* AWS.LakeFormation.DataLakeSettings(
              "Admin",
              { dataLakeAdmins: [admin] },
            );
            return { settings };
          }),
        );
        const goneTag = yield* lf
          .getLFTag({ TagKey: "alchemy-lf-env" })
          .pipe(
            Effect.catchTag("EntityNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
        expect(goneTag).toBeUndefined();

        yield* stack.destroy();
      }),
    { timeout: 240_000 },
  );

  test.provider(
    "LFTagExpression, DataCellsFilter, and OptIn lifecycle",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const admin = yield* callerPrincipalArn;

        const build = (options: {
          expressionValues: string[];
          rowFilterExpression?: string;
        }) =>
          Effect.gen(function* () {
            const settings = yield* AWS.LakeFormation.DataLakeSettings(
              "Admin",
              { dataLakeAdmins: [admin] },
            );
            const tag = yield* AWS.LakeFormation.LFTag("ExprTag", {
              catalogId: settings.catalogId,
              tagKey: "alchemy-lf-expr",
              tagValues: ["a", "b"],
            });
            const expression = yield* AWS.LakeFormation.LFTagExpression(
              "Expr",
              {
                catalogId: settings.catalogId,
                name: "alchemy-lf-expression",
                description: "alchemy test expression",
                expression: [
                  { tagKey: tag.tagKey, tagValues: options.expressionValues },
                ],
              },
            );
            const database = yield* AWS.Glue.Database("FilterDb", {});
            const table = yield* AWS.Glue.Table("FilterTable", {
              databaseName: database.databaseName,
              tableType: "EXTERNAL_TABLE",
              storageDescriptor: {
                location: "s3://example-bucket/lf-filter/",
                inputFormat:
                  "org.apache.hadoop.hive.ql.io.parquet.MapredParquetInputFormat",
                outputFormat:
                  "org.apache.hadoop.hive.ql.io.parquet.MapredParquetOutputFormat",
                serdeInfo: {
                  serializationLibrary:
                    "org.apache.hadoop.hive.ql.io.parquet.serde.ParquetHiveSerDe",
                },
                columns: [
                  { name: "id", type: "string" },
                  { name: "email", type: "string" },
                ],
              },
            });
            const filter = yield* AWS.LakeFormation.DataCellsFilter("NoEmail", {
              tableCatalogId: settings.catalogId,
              databaseName: database.databaseName,
              tableName: table.tableName,
              name: "alchemy-no-email",
              excludedColumnNames: ["email"],
              rowFilter:
                options.rowFilterExpression !== undefined
                  ? { filterExpression: options.rowFilterExpression }
                  : undefined,
            });
            const role = yield* AWS.IAM.Role("OptInRole", {
              assumeRolePolicyDocument: trustPolicy,
            });
            const optIn = yield* AWS.LakeFormation.OptIn("DbOptIn", {
              principal: role.roleArn,
              resource: {
                // consume settings.catalogId so admin bootstrap deploys first
                database: {
                  catalogId: settings.catalogId,
                  name: database.databaseName,
                },
              },
            });
            return {
              settings,
              tag,
              expression,
              database,
              table,
              filter,
              role,
              optIn,
            };
          });

        const created = yield* stack.deploy(build({ expressionValues: ["a"] }));

        expect(created.expression.name).toEqual("alchemy-lf-expression");
        expect(created.expression.expression).toEqual([
          { tagKey: "alchemy-lf-expr", tagValues: ["a"] },
        ]);
        expect(created.filter.name).toEqual("alchemy-no-email");
        expect(created.optIn.principal).toEqual(created.role.roleArn);

        // out-of-band verification
        const observedExpr = yield* lf.getLFTagExpression({
          Name: "alchemy-lf-expression",
        });
        expect(observedExpr.Expression?.[0]?.TagKey).toEqual("alchemy-lf-expr");
        expect(observedExpr.Expression?.[0]?.TagValues).toEqual(["a"]);
        const observedFilter = yield* lf.getDataCellsFilter({
          TableCatalogId: created.filter.tableCatalogId,
          DatabaseName: created.database.databaseName,
          TableName: created.table.tableName,
          Name: "alchemy-no-email",
        });
        expect(
          observedFilter.DataCellsFilter?.ColumnWildcard?.ExcludedColumnNames,
        ).toEqual(["email"]);
        const observedOptIns = yield* lf.listLakeFormationOptIns({
          Principal: {
            DataLakePrincipalIdentifier: created.role.roleArn,
          },
          Resource: {
            Database: { Name: created.database.databaseName },
          },
        });
        expect(
          observedOptIns.LakeFormationOptInsInfoList?.length,
        ).toBeGreaterThanOrEqual(1);

        // update — swap the expression's tag values and add a row filter
        yield* stack.deploy(
          build({ expressionValues: ["b"], rowFilterExpression: "id='x'" }),
        );

        const updatedExpr = yield* lf.getLFTagExpression({
          Name: "alchemy-lf-expression",
        });
        expect(updatedExpr.Expression?.[0]?.TagValues).toEqual(["b"]);
        const updatedFilter = yield* lf.getDataCellsFilter({
          TableCatalogId: created.filter.tableCatalogId,
          DatabaseName: created.database.databaseName,
          TableName: created.table.tableName,
          Name: "alchemy-no-email",
        });
        expect(
          updatedFilter.DataCellsFilter?.RowFilter?.FilterExpression,
        ).toEqual("id='x'");

        // remove everything but the admin bootstrap so deletion can be
        // verified out-of-band while the caller is still an admin
        yield* stack.deploy(
          Effect.gen(function* () {
            const settings = yield* AWS.LakeFormation.DataLakeSettings(
              "Admin",
              { dataLakeAdmins: [admin] },
            );
            return { settings };
          }),
        );

        const goneExpr = yield* lf
          .getLFTagExpression({ Name: "alchemy-lf-expression" })
          .pipe(
            Effect.catchTag("EntityNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
        expect(goneExpr).toBeUndefined();
        const goneOptIns = yield* lf.listLakeFormationOptIns({
          Principal: {
            DataLakePrincipalIdentifier: created.role.roleArn,
          },
        });
        expect(goneOptIns.LakeFormationOptInsInfoList ?? []).toHaveLength(0);

        yield* stack.destroy();
      }),
    { timeout: 240_000 },
  );
});
