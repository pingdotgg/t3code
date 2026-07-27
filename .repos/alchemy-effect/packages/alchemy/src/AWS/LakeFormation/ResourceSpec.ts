import type * as lf from "@distilled.cloud/aws/lakeformation";

/**
 * A Data Catalog reference (`Resource.Catalog`). Grants catalog-level
 * permissions such as `CREATE_DATABASE` or `CREATE_LF_TAG`.
 */
export interface CatalogSpec {
  /**
   * The catalog id (AWS account id).
   * @default the caller's account
   */
  id?: string;
}

/**
 * A Glue Data Catalog database reference (`Resource.Database`).
 */
export interface DatabaseResourceSpec {
  /**
   * The catalog id (AWS account id) the database lives in.
   * @default the caller's account
   */
  catalogId?: string;
  /**
   * Name of the Glue database.
   */
  name: string;
}

/**
 * A Glue Data Catalog table reference (`Resource.Table`). Provide either a
 * table `name` or `tableWildcard: true` for all tables in the database.
 */
export interface TableResourceSpec {
  /**
   * The catalog id (AWS account id) the table lives in.
   * @default the caller's account
   */
  catalogId?: string;
  /**
   * Name of the Glue database that contains the table.
   */
  databaseName: string;
  /**
   * Name of the table. Omit when using `tableWildcard`.
   */
  name?: string;
  /**
   * When true, references every table in the database.
   * @default false
   */
  tableWildcard?: boolean;
}

/**
 * A Glue table reference with a column filter (`Resource.TableWithColumns`).
 */
export interface TableWithColumnsResourceSpec {
  /**
   * The catalog id (AWS account id) the table lives in.
   * @default the caller's account
   */
  catalogId?: string;
  /**
   * Name of the Glue database that contains the table.
   */
  databaseName: string;
  /**
   * Name of the table.
   */
  name: string;
  /**
   * Include-list of column names. Mutually exclusive with
   * `excludedColumnNames`.
   */
  columnNames?: string[];
  /**
   * Exclude-list of column names (a column wildcard excluding these columns).
   * Mutually exclusive with `columnNames`.
   */
  excludedColumnNames?: string[];
}

/**
 * A registered S3 data location reference (`Resource.DataLocation`). Used to
 * grant `DATA_LOCATION_ACCESS`.
 */
export interface DataLocationResourceSpec {
  /**
   * The catalog id (AWS account id) that registered the location.
   * @default the caller's account
   */
  catalogId?: string;
  /**
   * ARN of the registered S3 location (e.g. `arn:aws:s3:::my-bucket`).
   */
  resourceArn: string;
}

/**
 * An LF-tag key/values reference (`Resource.LFTag`). Used to grant
 * permissions on the LF-tag itself (`DESCRIBE`, `ASSOCIATE`).
 */
export interface LFTagKeyResourceSpec {
  /**
   * The catalog id (AWS account id) the LF-tag lives in.
   * @default the caller's account
   */
  catalogId?: string;
  /**
   * Key of the LF-tag.
   */
  tagKey: string;
  /**
   * Values of the LF-tag the reference applies to.
   */
  tagValues: string[];
}

/**
 * An LF-tag policy expression (`Resource.LFTagPolicy`). Grants permissions on
 * all databases or tables whose LF-tags match the expression.
 */
export interface LFTagPolicyResourceSpec {
  /**
   * The catalog id (AWS account id).
   * @default the caller's account
   */
  catalogId?: string;
  /**
   * Whether the expression matches `DATABASE` or `TABLE` resources.
   */
  resourceType: lf.ResourceType;
  /**
   * The LF-tag conditions that resources must match.
   */
  expression: { tagKey: string; tagValues: string[] }[];
}

/**
 * A Lake Formation resource reference — exactly one variant should be set.
 * Mirrors the Lake Formation `Resource` union used by `GrantPermissions`,
 * `AddLFTagsToResource`, etc.
 */
export interface LakeFormationResourceSpec {
  /**
   * The Data Catalog itself (catalog-level permissions).
   */
  catalog?: CatalogSpec;
  /**
   * A Glue database.
   */
  database?: DatabaseResourceSpec;
  /**
   * A Glue table (or all tables via `tableWildcard`).
   */
  table?: TableResourceSpec;
  /**
   * A Glue table restricted to specific columns.
   */
  tableWithColumns?: TableWithColumnsResourceSpec;
  /**
   * A registered S3 data location.
   */
  dataLocation?: DataLocationResourceSpec;
  /**
   * An LF-tag key/values pair.
   */
  lfTag?: LFTagKeyResourceSpec;
  /**
   * An LF-tag policy expression.
   */
  lfTagPolicy?: LFTagPolicyResourceSpec;
}

/**
 * Convert a {@link LakeFormationResourceSpec} to the wire `Resource` union
 * shape expected by the Lake Formation API.
 */
export const toWireResource = (
  spec: LakeFormationResourceSpec,
): lf.Resource => {
  const resource: lf.Resource = {};
  if (spec.catalog !== undefined) {
    resource.Catalog = { Id: spec.catalog.id };
  }
  if (spec.database !== undefined) {
    resource.Database = {
      CatalogId: spec.database.catalogId,
      Name: spec.database.name,
    };
  }
  if (spec.table !== undefined) {
    resource.Table = {
      CatalogId: spec.table.catalogId,
      DatabaseName: spec.table.databaseName,
      Name: spec.table.name,
      TableWildcard: spec.table.tableWildcard ? {} : undefined,
    };
  }
  if (spec.tableWithColumns !== undefined) {
    resource.TableWithColumns = {
      CatalogId: spec.tableWithColumns.catalogId,
      DatabaseName: spec.tableWithColumns.databaseName,
      Name: spec.tableWithColumns.name,
      ColumnNames: spec.tableWithColumns.columnNames,
      ColumnWildcard:
        spec.tableWithColumns.excludedColumnNames !== undefined
          ? { ExcludedColumnNames: spec.tableWithColumns.excludedColumnNames }
          : undefined,
    };
  }
  if (spec.dataLocation !== undefined) {
    resource.DataLocation = {
      CatalogId: spec.dataLocation.catalogId,
      ResourceArn: spec.dataLocation.resourceArn,
    };
  }
  if (spec.lfTag !== undefined) {
    resource.LFTag = {
      CatalogId: spec.lfTag.catalogId,
      TagKey: spec.lfTag.tagKey,
      TagValues: spec.lfTag.tagValues,
    };
  }
  if (spec.lfTagPolicy !== undefined) {
    resource.LFTagPolicy = {
      CatalogId: spec.lfTagPolicy.catalogId,
      ResourceType: spec.lfTagPolicy.resourceType,
      Expression: spec.lfTagPolicy.expression.map((e) => ({
        TagKey: e.tagKey,
        TagValues: e.tagValues,
      })),
    };
  }
  return resource;
};
