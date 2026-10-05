import * as dm from "@distilled.cloud/gcp/datamigration_v1";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  conversionWorkspaceOf,
  encodeOwnershipLine,
  fingerprint,
  hasOwnershipMarker,
  listConversionWorkspaces,
  normalizeLocation,
  ownedByAlchemy,
  parseName,
  parseOwnership,
  replaceOnIdentity,
  ResourceNotResolved,
  toPhysicalId,
  waitUntilExists,
  waitUntilGone,
} from "./internal.ts";

export type MappingRuleRuleScope = dm.MappingRuleRuleScopeEnum | (string & {});
export type MappingRuleState = dm.MappingRuleStateEnum | (string & {});
export type MappingRuleFilter = dm.MappingRuleFilter;
export type FilterTableColumns = dm.FilterTableColumns;
export type SinglePackageChange = dm.SinglePackageChange;
export type SingleEntityRename = dm.SingleEntityRename;
export type SetTablePrimaryKey = dm.SetTablePrimaryKey;
export type MultiEntityRename = dm.MultiEntityRename;
export type EntityMove = dm.EntityMove;
export type SourceSqlChange = dm.SourceSqlChange;
export type MultiColumnDatatypeChange = dm.MultiColumnDatatypeChange;
export type ConvertRowIdToColumn = dm.ConvertRowIdToColumn;
export type SingleColumnChange = dm.SingleColumnChange;
export type ConditionalColumnSetValue = dm.ConditionalColumnSetValue;

export type ConversionWorkspacesMappingRuleProps = {
  /**
   * Parent conversion workspace. Full name
   * `projects/{project}/locations/{location}/conversionWorkspaces/{conversionWorkspace}`
   * or the workspace id (combined with `location`). Immutable — changing
   * it replaces the rule.
   */
  conversionWorkspace: string;
  /**
   * Region used when `conversionWorkspace` is a bare id.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * Mapping rule id (the `{mappingRule}` segment). If omitted, a unique
   * RFC1035 name is generated. Immutable — changing it replaces the rule.
   */
  mappingRuleId?: string;
  /**
   * Rule scope (`DATABASE_ENTITY_TYPE_SCHEMA`,
   * `DATABASE_ENTITY_TYPE_TABLE`, …). The API has no patch method —
   * changing the rule body replaces the rule.
   */
  ruleScope: MappingRuleRuleScope;
  /**
   * Entities the rule applies to.
   */
  filter?: MappingRuleFilter;
  /**
   * Application order. Lower values run first.
   * @default "1"
   */
  ruleOrder?: string;
  /**
   * User-friendly display name. Mapping rules have no labels field, so
   * ownership is stored in a `[alchemy …]` prefix and stripped from
   * attributes. The API has no patch method — changing display name
   * replaces the rule.
   */
  displayName?: string;
  /**
   * Mapping rule state (`ENABLED` or `DISABLED`).
   * @default "ENABLED"
   */
  state?: MappingRuleState;
  /** Rename a single entity. */
  singleEntityRename?: SingleEntityRename;
  /** Rename multiple entities. */
  multiEntityRename?: MultiEntityRename;
  /** Move entities into another schema. */
  entityMove?: EntityMove;
  /** Change SQL for a function or procedure. */
  sourceSqlChange?: SourceSqlChange;
  /** Change a single package. */
  singlePackageChange?: SinglePackageChange;
  /** Set a table primary key. */
  setTablePrimaryKey?: SetTablePrimaryKey;
  /** Filter table columns. */
  filterTableColumns?: FilterTableColumns;
  /** Change multiple column data types. */
  multiColumnDataTypeChange?: MultiColumnDatatypeChange;
  /** Convert ROWID to a column. */
  convertRowidColumn?: ConvertRowIdToColumn;
  /** Change a single column. */
  singleColumnChange?: SingleColumnChange;
  /** Conditionally transform column values. */
  conditionalColumnSetValue?: ConditionalColumnSetValue;
};

export type ConversionWorkspacesMappingRule = Resource<
  "GCP.DataMigration.ConversionWorkspacesMappingRule",
  ConversionWorkspacesMappingRuleProps,
  {
    /** Full resource name. */
    name: string;
    /** Mapping rule id (last path segment). */
    mappingRuleId: string;
    /** Parent conversion workspace resource name. */
    conversionWorkspace: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Rule scope. */
    ruleScope: string | undefined;
    /** Entity filter. */
    filter: MappingRuleFilter | undefined;
    /** Application order. */
    ruleOrder: string | undefined;
    /** User display name with the Alchemy ownership prefix stripped. */
    displayName: string | undefined;
    /** Mapping rule state. */
    state: string | undefined;
    /** Single-entity rename. */
    singleEntityRename: SingleEntityRename | undefined;
    /** Multi-entity rename. */
    multiEntityRename: MultiEntityRename | undefined;
    /** Entity move. */
    entityMove: EntityMove | undefined;
    /** Source SQL change. */
    sourceSqlChange: SourceSqlChange | undefined;
    /** Package change. */
    singlePackageChange: SinglePackageChange | undefined;
    /** Primary key change. */
    setTablePrimaryKey: SetTablePrimaryKey | undefined;
    /** Table column filter. */
    filterTableColumns: FilterTableColumns | undefined;
    /** Multi-column data type change. */
    multiColumnDataTypeChange: MultiColumnDatatypeChange | undefined;
    /** ROWID-to-column conversion. */
    convertRowidColumn: ConvertRowIdToColumn | undefined;
    /** Single-column change. */
    singleColumnChange: SingleColumnChange | undefined;
    /** Conditional column value transform. */
    conditionalColumnSetValue: ConditionalColumnSetValue | undefined;
    /** Revision id. */
    revisionId: string | undefined;
    /** RFC3339 revision timestamp. */
    revisionCreateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A mapping rule attached to a Database Migration Service conversion
 * workspace. Rules transform source schema entities into the destination
 * schema (rename, move, type change, …).
 *
 * Mapping rules have no labels field and no patch method — Alchemy stamps
 * ownership into the display name, and any change to the rule body
 * replaces the rule.
 *
 * ### Creating a Mapping Rule
 * **Example:** Rename a schema
 * ```typescript
 * const workspace = yield* GCP.DataMigration.ConversionWorkspace("MysqlToPg", {
 *   source: { engine: "MYSQL", version: "8.0" },
 *   destination: { engine: "POSTGRESQL", version: "14" },
 * });
 * const rule = yield* GCP.DataMigration.ConversionWorkspacesMappingRule("Rename", {
 *   conversionWorkspace: workspace.name,
 *   ruleScope: "DATABASE_ENTITY_TYPE_SCHEMA",
 *   filter: { entities: ["src_schema"] },
 *   singleEntityRename: { newName: "dst_schema" },
 * });
 * ```
 *
 * @resource
 * @category DataMigration
 */
export const ConversionWorkspacesMappingRule =
  Resource<ConversionWorkspacesMappingRule>(
    "GCP.DataMigration.ConversionWorkspacesMappingRule",
  );

const DEFAULT_ORDER = "1";

const resourceName = (conversionWorkspace: string, mappingRuleId: string) =>
  `${conversionWorkspace}/mappingRules/${mappingRuleId}`;

// The API omits `name` from mapping rules (create and get alike), so callers
// that know the rule's name pass it in.
const toAttrs = (item: dm.MappingRule, project: string, knownName?: string) => {
  const name = item.name || knownName || "";
  const parsed = parseName(name, "mappingRules");
  const ownership = parseOwnership(item.displayName);
  return {
    name,
    mappingRuleId: parsed.id,
    conversionWorkspace: parsed.parent,
    project: parsed.project || project,
    location: parsed.location,
    ruleScope: item.ruleScope,
    filter: item.filter,
    ruleOrder: item.ruleOrder,
    displayName: ownership.text,
    state: item.state,
    singleEntityRename: item.singleEntityRename,
    multiEntityRename: item.multiEntityRename,
    entityMove: item.entityMove,
    sourceSqlChange: item.sourceSqlChange,
    singlePackageChange: item.singlePackageChange,
    setTablePrimaryKey: item.setTablePrimaryKey,
    filterTableColumns: item.filterTableColumns,
    multiColumnDataTypeChange: item.multiColumnDataTypeChange,
    convertRowidColumn: item.convertRowidColumn,
    singleColumnChange: item.singleColumnChange,
    conditionalColumnSetValue: item.conditionalColumnSetValue,
    revisionId: item.revisionId,
    revisionCreateTime: item.revisionCreateTime,
  };
};

const ruleBody = (item: {
  ruleScope?: string;
  filter?: MappingRuleFilter;
  ruleOrder?: string;
  displayName?: string;
  state?: string;
  singleEntityRename?: SingleEntityRename;
  multiEntityRename?: MultiEntityRename;
  entityMove?: EntityMove;
  sourceSqlChange?: SourceSqlChange;
  singlePackageChange?: SinglePackageChange;
  setTablePrimaryKey?: SetTablePrimaryKey;
  filterTableColumns?: FilterTableColumns;
  multiColumnDataTypeChange?: MultiColumnDatatypeChange;
  convertRowidColumn?: ConvertRowIdToColumn;
  singleColumnChange?: SingleColumnChange;
  conditionalColumnSetValue?: ConditionalColumnSetValue;
}) =>
  fingerprint({
    ruleScope: item.ruleScope,
    filter: item.filter ?? {},
    ruleOrder: item.ruleOrder ?? DEFAULT_ORDER,
    displayName: item.displayName,
    state: item.state,
    singleEntityRename: item.singleEntityRename,
    multiEntityRename: item.multiEntityRename,
    entityMove: item.entityMove,
    sourceSqlChange: item.sourceSqlChange,
    singlePackageChange: item.singlePackageChange,
    setTablePrimaryKey: item.setTablePrimaryKey,
    filterTableColumns: item.filterTableColumns,
    multiColumnDataTypeChange: item.multiColumnDataTypeChange,
    convertRowidColumn: item.convertRowidColumn,
    singleColumnChange: item.singleColumnChange,
    conditionalColumnSetValue: item.conditionalColumnSetValue,
  });

// A name with an empty segment means the parent workspace never resolved
// (e.g. its create failed), so there is no rule to observe or delete.
const isWellFormed = (name: string) => name.length > 0 && !name.includes("//");

const getByName = (name: string) =>
  !isWellFormed(name)
    ? Effect.succeed(undefined)
    : dm.getProjectsLocationsConversionWorkspacesMappingRules({ name }).pipe(
        // Deleted rules stay readable as a `DELETED` revision.
        Effect.map((rule) => (rule.state === "DELETED" ? undefined : rule)),
        Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
      );

const listRules = (parent: string) =>
  dm.listProjectsLocationsConversionWorkspacesMappingRules
    .pages({ parent, pageSize: 1000 })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.mappingRules ?? [])),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () =>
        Effect.succeed([] as dm.MappingRule[]),
      ),
    );

const listOwned = (project: string, region: string) =>
  Effect.gen(function* () {
    const workspaces = yield* listConversionWorkspaces(project, region);
    const groups = yield* Effect.forEach(
      workspaces.filter((item) => (item.name ?? "").length > 0),
      (workspace) => listRules(workspace.name!),
      { concurrency: 4 },
    );
    return groups.flat().filter((item) => hasOwnershipMarker(item.displayName));
  });

export const ConversionWorkspacesMappingRuleProvider = () =>
  Provider.succeed(ConversionWorkspacesMappingRule, {
    stables: [
      "name",
      "mappingRuleId",
      "conversionWorkspace",
      "project",
      "location",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previous = {
        ruleScope: olds?.ruleScope ?? output?.ruleScope,
        filter: olds?.filter ?? output?.filter,
        ruleOrder: olds?.ruleOrder ?? output?.ruleOrder,
        displayName: olds?.displayName ?? output?.displayName,
        state: olds?.state ?? output?.state,
        singleEntityRename:
          olds?.singleEntityRename ?? output?.singleEntityRename,
        multiEntityRename: olds?.multiEntityRename ?? output?.multiEntityRename,
        entityMove: olds?.entityMove ?? output?.entityMove,
        sourceSqlChange: olds?.sourceSqlChange ?? output?.sourceSqlChange,
        singlePackageChange:
          olds?.singlePackageChange ?? output?.singlePackageChange,
        setTablePrimaryKey:
          olds?.setTablePrimaryKey ?? output?.setTablePrimaryKey,
        filterTableColumns:
          olds?.filterTableColumns ?? output?.filterTableColumns,
        multiColumnDataTypeChange:
          olds?.multiColumnDataTypeChange ?? output?.multiColumnDataTypeChange,
        convertRowidColumn:
          olds?.convertRowidColumn ?? output?.convertRowidColumn,
        singleColumnChange:
          olds?.singleColumnChange ?? output?.singleColumnChange,
        conditionalColumnSetValue:
          olds?.conditionalColumnSetValue ?? output?.conditionalColumnSetValue,
      };
      return replaceOnIdentity({
        previousId: olds?.mappingRuleId ?? output?.mappingRuleId,
        nextId:
          news.mappingRuleId ?? olds?.mappingRuleId ?? output?.mappingRuleId,
        previousLocation: normalizeLocation(
          olds?.location ?? output?.location,
          env.region,
        ),
        nextLocation: normalizeLocation(
          news.location ?? olds?.location ?? output?.location,
          env.region,
        ),
        previousParent:
          olds?.conversionWorkspace ?? output?.conversionWorkspace,
        nextParent: news.conversionWorkspace,
        extra:
          (olds !== undefined || output !== undefined) &&
          ruleBody(news) !== ruleBody(previous),
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const conversionWorkspace = conversionWorkspaceOf(
        olds?.conversionWorkspace ?? output?.conversionWorkspace ?? "",
        env.project,
        location,
      );
      const mappingRuleId = yield* toPhysicalId(
        id,
        olds?.mappingRuleId,
        output?.mappingRuleId,
        "rule",
      );
      const name =
        output?.name ??
        (conversionWorkspace.length > 0
          ? resourceName(conversionWorkspace, mappingRuleId)
          : "");
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, name);
      return (yield* ownedByAlchemy(id, existing.displayName))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const items = yield* listOwned(env.project, env.region);
        return items.map((item) => toAttrs(item, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const conversionWorkspace = conversionWorkspaceOf(
        news.conversionWorkspace,
        env.project,
        location,
      );
      const mappingRuleId = yield* toPhysicalId(
        id,
        news.mappingRuleId,
        output?.mappingRuleId,
        "rule",
      );
      const name = resourceName(conversionWorkspace, mappingRuleId);
      const ownership = yield* createInternalLabels(id);
      const displayName = encodeOwnershipLine(ownership, news.displayName);
      const ruleOrder = news.ruleOrder ?? DEFAULT_ORDER;
      const filter = news.filter ?? {};

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* dm
          .createProjectsLocationsConversionWorkspacesMappingRules({
            parent: conversionWorkspace,
            mappingRuleId,
            body: {
              displayName,
              ruleScope: news.ruleScope,
              filter,
              ruleOrder,
              state: news.state ?? "ENABLED",
              singleEntityRename: news.singleEntityRename,
              multiEntityRename: news.multiEntityRename,
              entityMove: news.entityMove,
              sourceSqlChange: news.sourceSqlChange,
              singlePackageChange: news.singlePackageChange,
              setTablePrimaryKey: news.setTablePrimaryKey,
              filterTableColumns: news.filterTableColumns,
              multiColumnDataTypeChange: news.multiColumnDataTypeChange,
              convertRowidColumn: news.convertRowidColumn,
              singleColumnChange: news.singleColumnChange,
              conditionalColumnSetValue: news.conditionalColumnSetValue,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          current = created;
        } else {
          current = yield* waitUntilExists(getByName(name), name);
        }
      }

      if (current === undefined) {
        return yield* new ResourceNotResolved({ name });
      }

      return toAttrs(current, env.project, output?.name ?? name);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!isWellFormed(output.name)) return;
      const deleted = yield* dm
        .deleteProjectsLocationsConversionWorkspacesMappingRules({
          name: output.name,
        })
        .pipe(
          Effect.as(true),
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("2 seconds"),
          }),
          // The API answers NotFound for rules it still serves on GET (they
          // only go away with their workspace), so there is nothing to wait on.
          Effect.catchTag("NotFound", () => Effect.succeed(false)),
        );
      if (deleted) {
        yield* waitUntilGone(getByName(output.name), output.name);
      }
    }),
  });
