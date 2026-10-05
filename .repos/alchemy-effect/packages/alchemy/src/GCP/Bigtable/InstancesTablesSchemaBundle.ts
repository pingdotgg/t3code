import * as bigtable from "@distilled.cloud/gcp/bigtableadmin_v2";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  instanceIdOf,
  listAlchemyTables,
  MAX_SCHEMA_BUNDLE_ID_LENGTH,
  parentOwned,
  parseResourceName,
  tableIdOf,
  tableNameOf,
  toPhysicalId,
  waitForOperation,
  collectPages,
} from "./operations.ts";

export type InstancesTablesSchemaBundleProps = {
  /**
   * Parent instance. Full name `projects/{project}/instances/{instance}`
   * or the instance id. Immutable — changing it replaces the bundle.
   */
  instance: string;
  /**
   * Parent table. Full name
   * `projects/{project}/instances/{instance}/tables/{table}` or the table
   * id. Immutable — changing it replaces the bundle.
   */
  table: string;
  /**
   * Schema bundle id (the `{schema_bundle}` segment of
   * `.../tables/{table}/schemaBundles/{schema_bundle}`). If omitted, a
   * unique name is generated from the stack, stage, and logical id.
   * Immutable — changing it replaces the bundle.
   */
  schemaBundleId?: string;
  /**
   * Base64-encoded protobuf `FileDescriptorSet` (`protoc
   * --include_imports --descriptor_set_out`).
   */
  protoDescriptors: string;
  /**
   * Ignore backwards-compatibility checks on update.
   * @default true
   */
  ignoreWarnings?: boolean;
};

export type InstancesTablesSchemaBundle = Resource<
  "GCP.Bigtable.InstancesTablesSchemaBundle",
  InstancesTablesSchemaBundleProps,
  {
    /** Full resource name `.../tables/{table}/schemaBundles/{schema_bundle}`. */
    name: string;
    /** Schema bundle id (last path segment). */
    schemaBundleId: string;
    /** Parent table resource name. */
    table: string;
    /** Parent table id. */
    tableId: string;
    /** Parent instance resource name. */
    instance: string;
    /** Parent instance id. */
    instanceId: string;
    /** Project id. */
    project: string;
    /** Base64-encoded FileDescriptorSet currently stored. */
    protoDescriptors: string | undefined;
    /** Server etag. */
    etag: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Cloud Bigtable schema bundle — a named FileDescriptorSet used to
 * decode protobuf cell values.
 *
 * The parent instance and table must already exist. Changing
 * `schemaBundleId`, `instance`, or `table` replaces the bundle.
 * `protoDescriptors` update in place (must be backwards compatible
 * unless `ignoreWarnings` is true).
 *
 * Schema bundles have no labels field. Alchemy treats a bundle as owned
 * when its parent instance carries Alchemy labels, so `list` /
 * `pnpm nuke:gcp` can find it.
 *
 * ### Creating a Schema Bundle
 * **Example:** Bundle from a FileDescriptorSet
 * ```typescript
 * const bundle = yield* GCP.Bigtable.InstancesTablesSchemaBundle("Rows", {
 *   instance: instance.name,
 *   table: table.name,
 *   protoDescriptors: descriptors,
 * });
 * ```
 *
 * @resource
 * @category Bigtable
 */
export const InstancesTablesSchemaBundle =
  Resource<InstancesTablesSchemaBundle>(
    "GCP.Bigtable.InstancesTablesSchemaBundle",
  );

export class SchemaBundleNotResolved extends Data.TaggedError(
  "GCP.Bigtable.SchemaBundleNotResolved",
)<{
  name: string;
}> {}

export class SchemaBundleStillExists extends Data.TaggedError(
  "GCP.Bigtable.SchemaBundleStillExists",
)<{
  name: string;
}> {}

const toId = (
  id: string,
  schemaBundleId: string | undefined,
  existing?: string,
) => toPhysicalId(id, schemaBundleId, existing, MAX_SCHEMA_BUNDLE_ID_LENGTH);

const descriptorsOf = (
  schema: bigtable.ProtoSchema | { protoDescriptors?: string } | undefined,
) => schema?.protoDescriptors ?? "";

const toAttrs = (bundle: bigtable.SchemaBundle, project: string) => {
  const name = bundle.name ?? "";
  const parsed = parseResourceName(name);
  return {
    name,
    schemaBundleId: parsed.schemaBundleId,
    table: parsed.table,
    tableId: parsed.tableId,
    instance: parsed.instance,
    instanceId: parsed.instanceId,
    project: parsed.project || project,
    protoDescriptors: bundle.protoSchema?.protoDescriptors,
    etag: bundle.etag,
  };
};

const getByName = (name: string) =>
  bigtable
    .getProjectsInstancesTablesSchemaBundles({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const waitUntilExists = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((bundle) =>
      bundle
        ? Effect.succeed(bundle)
        : Effect.fail(new SchemaBundleNotResolved({ name })),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.Bigtable.SchemaBundleNotResolved",
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
  );

const waitUntilGone = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((bundle) =>
      bundle === undefined
        ? Effect.void
        : Effect.fail(new SchemaBundleStillExists({ name })),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.Bigtable.SchemaBundleStillExists",
      times: 8,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

export const InstancesTablesSchemaBundleProvider = () =>
  Provider.succeed(InstancesTablesSchemaBundle, {
    stables: [
      "name",
      "schemaBundleId",
      "table",
      "tableId",
      "instance",
      "instanceId",
      "project",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId = olds?.schemaBundleId ?? output?.schemaBundleId;
      const nextId = news.schemaBundleId ?? previousId;
      const previousInstance = instanceIdOf(
        olds?.instance ?? output?.instance ?? output?.instanceId ?? "",
      );
      const nextInstance = instanceIdOf(news.instance);
      const previousTable = tableIdOf(
        olds?.table ?? output?.table ?? output?.tableId ?? "",
      );
      const nextTable = tableIdOf(news.table);
      if (
        (previousId !== undefined &&
          nextId !== undefined &&
          previousId !== nextId) ||
        (previousInstance.length > 0 && previousInstance !== nextInstance) ||
        (previousTable.length > 0 && previousTable !== nextTable)
      ) {
        return { action: "replace" as const };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const schemaBundleId = yield* toId(
        id,
        olds?.schemaBundleId,
        output?.schemaBundleId,
      );
      const instanceRef = olds?.instance ?? output?.instance;
      const tableRef = olds?.table ?? output?.table;
      const name =
        output?.name ??
        (instanceRef && tableRef
          ? `${tableNameOf(env.project, instanceRef, tableRef)}/schemaBundles/${schemaBundleId}`
          : undefined);
      if (name === undefined) return undefined;
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* parentOwned(attrs.instance)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const tables = (yield* listAlchemyTables(env.project)).filter(
          (table): table is bigtable.Table & { name: string } =>
            typeof table.name === "string" && table.name.length > 0,
        );
        const pages = yield* Effect.forEach(
          tables,
          (table) =>
            collectPages(
              bigtable.listProjectsInstancesTablesSchemaBundles.pages({
                parent: table.name,
                pageSize: 1000,
              }),
              (page) => page.schemaBundles,
            ).pipe(
              Effect.catchTag("NotFound", () =>
                Effect.succeed([] as bigtable.SchemaBundle[]),
              ),
            ),
          { concurrency: 4 },
        );
        return pages.flat().map((bundle) => toAttrs(bundle, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const schemaBundleId = yield* toId(
        id,
        news.schemaBundleId,
        output?.schemaBundleId,
      );
      const parent = tableNameOf(env.project, news.instance, news.table);
      const name = `${parent}/schemaBundles/${schemaBundleId}`;
      const ignoreWarnings = news.ignoreWarnings ?? true;
      const protoSchema = { protoDescriptors: news.protoDescriptors };

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* bigtable
          .createProjectsInstancesTablesSchemaBundles({
            parent,
            schemaBundleId,
            body: { protoSchema },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          yield* waitForOperation(created, { alreadyExistsOk: true });
        }
        current = yield* waitUntilExists(name);
      }

      if (descriptorsOf(current.protoSchema) !== news.protoDescriptors) {
        const patched = yield* bigtable
          .patchProjectsInstancesTablesSchemaBundles({
            name,
            updateMask: "proto_schema",
            ignoreWarnings,
            body: { protoSchema, etag: current.etag },
          })
          .pipe(
            Effect.retry({
              while: (error) => error._tag === "Conflict",
              times: 8,
              schedule: Schedule.spaced("1 second"),
            }),
          );
        yield* waitForOperation(patched);
        current = yield* getByName(name);
        if (current === undefined) {
          return yield* new SchemaBundleNotResolved({ name });
        }
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* bigtable
        .deleteProjectsInstancesTablesSchemaBundles({
          name: output.name,
        })
        .pipe(
          Effect.catchTag("NotFound", () => Effect.void),
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("2 seconds"),
          }),
        );
      yield* waitUntilGone(output.name);
    }),
  });
