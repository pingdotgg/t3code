import * as bigquery from "@distilled.cloud/gcp/bigquery_v2";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import {
  ALCHEMY_LABEL_PREFIX,
  alchemyLabelKeys,
  createInternalLabels,
  hasAlchemyLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";

const MAX_ROUTINE_ID_LENGTH = 256;
const DEFAULT_LANGUAGE = "SQL";
const DEFAULT_ARGUMENT_KIND = "FIXED_TYPE";

export type RoutineType = bigquery.RoutineRoutineTypeEnum | (string & {});
export type RoutineLanguage = bigquery.RoutineLanguageEnum | (string & {});
export type RoutineArgument = bigquery.Argument;
export type RoutineDataType = bigquery.StandardSqlDataType;
export type RoutineReturnTableType = bigquery.StandardSqlTableType;
export type RoutineSparkOptions = bigquery.SparkOptions;
export type RoutineRemoteFunctionOptions = bigquery.RemoteFunctionOptions;
export type RoutinePythonOptions = bigquery.PythonOptions;
export type RoutineExternalRuntimeOptions = bigquery.ExternalRuntimeOptions;
export type RoutineDeterminismLevel =
  | bigquery.RoutineDeterminismLevelEnum
  | (string & {});
export type RoutineSecurityMode =
  | bigquery.RoutineSecurityModeEnum
  | (string & {});
export type RoutineDataGovernanceType =
  | bigquery.RoutineDataGovernanceTypeEnum
  | (string & {});

export type RoutineProps = {
  /**
   * Dataset id (the `{dataset}` segment of
   * `projects/{project}/datasets/{dataset}`) or a full dataset resource
   * name. Immutable — changing it replaces the routine.
   */
  datasetId: string;
  /**
   * Routine id (the `{routine}` segment of
   * `projects/{project}/datasets/{dataset}/routines/{routine}`). If omitted,
   * a unique name is generated from the stack, stage, and logical id. Must
   * contain only letters, numbers, and underscores; max 256 characters.
   * Immutable — changing it replaces the routine.
   */
  routineId?: string;
  /**
   * Routine kind (`SCALAR_FUNCTION`, `PROCEDURE`, `TABLE_VALUED_FUNCTION`,
   * `AGGREGATE_FUNCTION`). Immutable — changing it replaces the routine.
   */
  routineType: RoutineType;
  /**
   * Body of the routine. For SQL functions this is the expression inside
   * the `AS (…)` clause, not a full `CREATE FUNCTION` statement. For
   * JavaScript, the evaluated string in the `AS` clause.
   */
  definitionBody: string;
  /**
   * Implementation language (`SQL`, `JAVASCRIPT`, `PYTHON`, `JAVA`,
   * `SCALA`). Defaults to `SQL` unless `remoteFunctionOptions` is set.
   */
  language?: RoutineLanguage;
  /**
   * Input/output arguments. `mode` is valid on procedures only.
   */
  arguments?: RoutineArgument[];
  /**
   * Return type for scalar and aggregate functions. Optional for SQL
   * (inferred at query time); required for other languages.
   */
  returnType?: RoutineDataType;
  /**
   * Return table schema when `routineType` is `TABLE_VALUED_FUNCTION`.
   * Optional for SQL (inferred at query time).
   */
  returnTableType?: RoutineReturnTableType;
  /**
   * User-friendly description of this routine. Alchemy ownership is stored
   * in a `[alchemy …]` prefix for `list` / nuke.
   */
  description?: string;
  /**
   * GCS paths of imported JavaScript libraries when `language` is
   * `JAVASCRIPT`.
   */
  importedLibraries?: string[];
  /**
   * Determinism of a JavaScript UDF (`DETERMINISTIC`,
   * `NOT_DETERMINISTIC`).
   */
  determinismLevel?: RoutineDeterminismLevel;
  /**
   * Security mode (`DEFINER`, `INVOKER`). If omitted, BigQuery infers it
   * from the routine configuration.
   */
  securityMode?: RoutineSecurityMode;
  /**
   * Set to `DATA_MASKING` to register a custom masking function.
   */
  dataGovernanceType?: RoutineDataGovernanceType;
  /**
   * Extra validation for procedure bodies. Default `true`. Recursive
   * procedures should set this to `false`.
   * @default true
   */
  strictMode?: boolean;
  /**
   * Spark procedure options (`JAVA` / `SCALA` / PySpark).
   */
  sparkOptions?: RoutineSparkOptions;
  /**
   * Remote function endpoint and connection.
   */
  remoteFunctionOptions?: RoutineRemoteFunctionOptions;
  /**
   * Python UDF entry point and packages.
   */
  pythonOptions?: RoutinePythonOptions;
  /**
   * Container limits for Python UDFs.
   */
  externalRuntimeOptions?: RoutineExternalRuntimeOptions;
};

export type Routine = Resource<
  "GCP.BigQuery.Routine",
  RoutineProps,
  {
    /**
     * Resource path
     * `projects/{project}/datasets/{dataset}/routines/{routine}`.
     */
    name: string;
    /** Opaque id `project:dataset.routine`. */
    id: string;
    /** Routine id (last path segment). */
    routineId: string;
    /** Dataset id. */
    datasetId: string;
    /** Project id. */
    project: string;
    /** Routine kind. */
    routineType: string;
    /** Implementation language, if set. */
    language: string | undefined;
    /** Routine body. */
    definitionBody: string;
    /** Arguments, if set. */
    arguments: RoutineArgument[] | undefined;
    /** Scalar/aggregate return type, if set. */
    returnType: RoutineDataType | undefined;
    /** TVF return table type, if set. */
    returnTableType: RoutineReturnTableType | undefined;
    /** Description, if set. */
    description: string | undefined;
    /** Imported JavaScript libraries. */
    importedLibraries: string[] | undefined;
    /** JavaScript determinism, if set. */
    determinismLevel: string | undefined;
    /** Security mode, if set. */
    securityMode: string | undefined;
    /** Data-governance classification, if set. */
    dataGovernanceType: string | undefined;
    /** Procedure strict-mode flag. */
    strictMode: boolean | undefined;
    /** Spark options, if set. */
    sparkOptions: RoutineSparkOptions | undefined;
    /** Remote function options, if set. */
    remoteFunctionOptions: RoutineRemoteFunctionOptions | undefined;
    /** Python UDF options, if set. */
    pythonOptions: RoutinePythonOptions | undefined;
    /** Python runtime options, if set. */
    externalRuntimeOptions: RoutineExternalRuntimeOptions | undefined;
    /** Creation time in milliseconds since epoch. */
    creationTime: string | undefined;
    /** Last-modified time in milliseconds since epoch. */
    lastModifiedTime: string | undefined;
    /** Server etag. */
    etag: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Google BigQuery routine — a user-defined function, table-valued
 * function, aggregate function, or stored procedure.
 *
 * Routines have no labels; Alchemy stamps ownership into the description
 * (`[alchemy alchemy-stack=… alchemy-stage=… alchemy-id=…]`) so `list` /
 * `pnpm nuke:gcp` can find them inside datasets that carry `alchemy-*`
 * labels. `datasetId`, `routineId`, and `routineType` are immutable
 * (changing them replaces the routine). Body, arguments, description,
 * language, and language-specific options update in place via a
 * full-resource replace.
 *
 * ### Creating a Routine
 * **Example:** SQL scalar function
 * ```typescript
 * const dataset = yield* GCP.BigQuery.Dataset("Analytics", {
 *   forceDestroy: true,
 * });
 * const add = yield* GCP.BigQuery.Routine("Add", {
 *   datasetId: dataset.datasetId,
 *   routineType: "SCALAR_FUNCTION",
 *   language: "SQL",
 *   arguments: [
 *     { name: "x", dataType: { typeKind: "INT64" } },
 *     { name: "y", dataType: { typeKind: "INT64" } },
 *   ],
 *   returnType: { typeKind: "INT64" },
 *   definitionBody: "x + y",
 * });
 * ```
 *
 * **Example:** SQL stored procedure
 * ```typescript
 * const proc = yield* GCP.BigQuery.Routine("Seed", {
 *   datasetId: dataset.datasetId,
 *   routineType: "PROCEDURE",
 *   language: "SQL",
 *   definitionBody: "SELECT 1",
 * });
 * ```
 *
 * **Example:** JavaScript UDF
 * ```typescript
 * const multiply = yield* GCP.BigQuery.Routine("Multiply", {
 *   datasetId: dataset.datasetId,
 *   routineType: "SCALAR_FUNCTION",
 *   language: "JAVASCRIPT",
 *   determinismLevel: "DETERMINISTIC",
 *   arguments: [
 *     { name: "x", dataType: { typeKind: "FLOAT64" } },
 *     { name: "y", dataType: { typeKind: "FLOAT64" } },
 *   ],
 *   returnType: { typeKind: "FLOAT64" },
 *   definitionBody: "return x * y;",
 * });
 * ```
 *
 * ### Calling a Routine
 * **Example:** Invoke a SQL function with Query
 * ```typescript
 * const query = yield* GCP.BigQuery.Query(dataset);
 * const result = yield* query({ query: "SELECT Add(1, 2) AS n" });
 * ```
 *
 * @resource
 * @category BigQuery
 */
export const Routine = Resource<Routine>("GCP.BigQuery.Routine");

export class RoutineNotResolved extends Data.TaggedError(
  "GCP.BigQuery.RoutineNotResolved",
)<{
  name: string;
}> {}

const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

const datasetIdOf = (datasetId: string) =>
  datasetId.includes("/") ? lastSegment(datasetId) : datasetId;

const resourceName = (project: string, datasetId: string, routineId: string) =>
  `projects/${project}/datasets/${datasetId}/routines/${routineId}`;

const toId = (id: string, routineId: string | undefined, existing?: string) =>
  Effect.gen(function* () {
    if (routineId !== undefined) return routineId;
    if (existing !== undefined) return existing;
    const generated = yield* createPhysicalName({
      id,
      maxLength: MAX_ROUTINE_ID_LENGTH,
      lowercase: true,
      delimiter: "_",
    });
    return generated.replaceAll("-", "_");
  });

const stable = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stable);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, nested]) => nested !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, stable(nested)]),
    );
  }
  return value;
};

const jsonEqual = (left: unknown, right: unknown) =>
  JSON.stringify(stable(left ?? null)) ===
  JSON.stringify(stable(right ?? null));

const canonType = (
  type: RoutineDataType | undefined,
): RoutineDataType | undefined => {
  if (type === undefined) return undefined;
  return {
    typeKind: type.typeKind,
    arrayElementType: canonType(type.arrayElementType),
    rangeElementType: canonType(type.rangeElementType),
    structType: type.structType
      ? {
          fields: (type.structType.fields ?? []).map((field) => ({
            name: field.name,
            type: canonType(field.type),
          })),
        }
      : undefined,
  };
};

const canonArguments = (args: RoutineArgument[] | undefined) =>
  (args ?? []).map((argument) => ({
    name: argument.name ?? "",
    argumentKind: argument.argumentKind ?? DEFAULT_ARGUMENT_KIND,
    mode: argument.mode,
    isAggregate: argument.isAggregate,
    dataType: canonType(argument.dataType),
  }));

const encodeDescription = (
  labels: Record<string, string>,
  description: string | undefined,
): string => {
  const marker = `[alchemy ${alchemyLabelKeys.stack}=${labels[alchemyLabelKeys.stack]} ${alchemyLabelKeys.stage}=${labels[alchemyLabelKeys.stage]} ${alchemyLabelKeys.id}=${labels[alchemyLabelKeys.id]}]`;
  return description ? `${marker}\n${description}` : marker;
};

const parseDescription = (
  description: string | undefined,
): {
  labels: Record<string, string>;
  description: string | undefined;
} => {
  if (!description?.startsWith("[alchemy ")) {
    return { labels: {}, description };
  }
  const end = description.indexOf("]");
  if (end < 0) return { labels: {}, description };
  const labels: Record<string, string> = {};
  for (const part of description.slice("[alchemy ".length, end).split(/\s+/)) {
    const eq = part.indexOf("=");
    if (eq > 0) {
      labels[part.slice(0, eq)] = part.slice(eq + 1);
    }
  }
  const rest = description.slice(end + 1).replace(/^\n/, "");
  return { labels, description: rest.length > 0 ? rest : undefined };
};

const hasOwnershipMarker = (description: string | undefined) =>
  Object.keys(parseDescription(description).labels).some((key) =>
    key.startsWith(ALCHEMY_LABEL_PREFIX),
  );

const toAttrs = (routine: bigquery.Routine, project: string) => {
  const ref = routine.routineReference;
  const routineId = ref?.routineId ?? "";
  const datasetId = ref?.datasetId ?? "";
  const projectId = ref?.projectId ?? project;
  return {
    name: resourceName(projectId, datasetId, routineId),
    id: `${projectId}:${datasetId}.${routineId}`,
    routineId,
    datasetId,
    project: projectId,
    routineType: routine.routineType ?? "",
    language: routine.language,
    definitionBody: routine.definitionBody ?? "",
    arguments: routine.arguments,
    returnType: routine.returnType,
    returnTableType: routine.returnTableType,
    description: parseDescription(routine.description).description,
    importedLibraries: routine.importedLibraries,
    determinismLevel: routine.determinismLevel,
    securityMode: routine.securityMode,
    dataGovernanceType: routine.dataGovernanceType,
    strictMode: routine.strictMode,
    sparkOptions: routine.sparkOptions,
    remoteFunctionOptions: routine.remoteFunctionOptions,
    pythonOptions: routine.pythonOptions,
    externalRuntimeOptions: routine.externalRuntimeOptions,
    creationTime: routine.creationTime,
    lastModifiedTime: routine.lastModifiedTime,
    etag: routine.etag,
  };
};

const getByRef = (projectId: string, datasetId: string, routineId: string) =>
  bigquery
    .getRoutines({ projectId, datasetId, routineId })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const defaultLanguage = (news: RoutineProps, observed?: bigquery.Routine) => {
  if (news.language !== undefined) return news.language;
  if (observed?.language !== undefined) return observed.language;
  if (
    news.remoteFunctionOptions !== undefined ||
    observed?.remoteFunctionOptions !== undefined
  ) {
    return undefined;
  }
  return DEFAULT_LANGUAGE;
};

const pick = <T>(news: T | undefined, observed: T | undefined) =>
  news !== undefined ? news : observed;

const toRoutineBody = (
  projectId: string,
  datasetId: string,
  routineId: string,
  news: RoutineProps,
  encodedDescription: string,
  observed?: bigquery.Routine,
): bigquery.Routine => {
  const body: bigquery.Routine = {
    routineReference: { projectId, datasetId, routineId },
    routineType: news.routineType,
    definitionBody: news.definitionBody,
    description: encodedDescription,
  };
  const language = defaultLanguage(news, observed);
  if (language !== undefined) body.language = language;
  const args = pick(news.arguments, observed?.arguments);
  if (args !== undefined) body.arguments = args;
  const returnType = pick(news.returnType, observed?.returnType);
  if (returnType !== undefined) body.returnType = returnType;
  const returnTableType = pick(news.returnTableType, observed?.returnTableType);
  if (returnTableType !== undefined) body.returnTableType = returnTableType;
  const importedLibraries = pick(
    news.importedLibraries,
    observed?.importedLibraries,
  );
  if (importedLibraries !== undefined) {
    body.importedLibraries = importedLibraries;
  }
  const determinismLevel = pick(
    news.determinismLevel,
    observed?.determinismLevel,
  );
  if (determinismLevel !== undefined) body.determinismLevel = determinismLevel;
  const securityMode = pick(news.securityMode, observed?.securityMode);
  if (securityMode !== undefined) body.securityMode = securityMode;
  const dataGovernanceType = pick(
    news.dataGovernanceType,
    observed?.dataGovernanceType,
  );
  if (dataGovernanceType !== undefined) {
    body.dataGovernanceType = dataGovernanceType;
  }
  const strictMode = pick(news.strictMode, observed?.strictMode);
  if (strictMode !== undefined) body.strictMode = strictMode;
  const sparkOptions = pick(news.sparkOptions, observed?.sparkOptions);
  if (sparkOptions !== undefined) body.sparkOptions = sparkOptions;
  const remoteFunctionOptions = pick(
    news.remoteFunctionOptions,
    observed?.remoteFunctionOptions,
  );
  if (remoteFunctionOptions !== undefined) {
    body.remoteFunctionOptions = remoteFunctionOptions;
  }
  const pythonOptions = pick(news.pythonOptions, observed?.pythonOptions);
  if (pythonOptions !== undefined) body.pythonOptions = pythonOptions;
  const externalRuntimeOptions = pick(
    news.externalRuntimeOptions,
    observed?.externalRuntimeOptions,
  );
  if (externalRuntimeOptions !== undefined) {
    body.externalRuntimeOptions = externalRuntimeOptions;
  }
  return body;
};

const inputSnapshot = (routine: bigquery.Routine) => ({
  routineType: (routine.routineType ?? "").toUpperCase(),
  language: routine.language,
  definitionBody: routine.definitionBody ?? "",
  arguments: canonArguments(routine.arguments),
  returnType: canonType(routine.returnType),
  returnTableType: routine.returnTableType
    ? {
        columns: (routine.returnTableType.columns ?? []).map((column) => ({
          name: column.name,
          type: canonType(column.type),
        })),
      }
    : undefined,
  description: routine.description ?? "",
  importedLibraries: routine.importedLibraries ?? [],
  determinismLevel: routine.determinismLevel,
  securityMode: routine.securityMode,
  dataGovernanceType: routine.dataGovernanceType,
  strictMode: routine.strictMode,
  sparkOptions: routine.sparkOptions,
  remoteFunctionOptions: routine.remoteFunctionOptions,
  pythonOptions: routine.pythonOptions,
  externalRuntimeOptions: routine.externalRuntimeOptions,
});

const hasAlchemyDatasetLabels = (
  labels: Record<string, string | undefined> | null | undefined,
) =>
  Object.keys(labels ?? {}).some((key) => key.startsWith(ALCHEMY_LABEL_PREFIX));

export const RoutineProvider = () =>
  Provider.succeed(Routine, {
    stables: [
      "name",
      "id",
      "routineId",
      "datasetId",
      "project",
      "routineType",
      "creationTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousRoutineId = olds?.routineId ?? output?.routineId;
      const nextRoutineId = news.routineId ?? previousRoutineId;
      const routineIdChanged =
        news.routineId !== undefined &&
        previousRoutineId !== undefined &&
        news.routineId !== previousRoutineId;

      const previousDataset = olds?.datasetId ?? output?.datasetId;
      const nextDataset = datasetIdOf(news.datasetId);
      const datasetChanged =
        previousDataset !== undefined &&
        datasetIdOf(previousDataset) !== nextDataset;

      const previousType = (
        olds?.routineType ??
        output?.routineType ??
        ""
      ).toUpperCase();
      const typeChanged =
        previousType.length > 0 &&
        news.routineType.toUpperCase() !== previousType;

      if (!routineIdChanged && !datasetChanged && !typeChanged) {
        return undefined;
      }
      return {
        action: "replace" as const,
        deleteFirst:
          !routineIdChanged &&
          !datasetChanged &&
          nextRoutineId !== undefined &&
          previousRoutineId !== undefined &&
          nextRoutineId === previousRoutineId,
      };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const routineId = yield* toId(id, olds?.routineId, output?.routineId);
      const datasetId = datasetIdOf(olds?.datasetId ?? output?.datasetId ?? "");
      if (datasetId.length === 0) return undefined;
      const existing = yield* getByRef(env.project, datasetId, routineId);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* hasAlchemyLabels(
        id,
        parseDescription(existing.description).labels,
      ))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const datasets = yield* bigquery.listDatasets
          .pages({
            projectId: env.project,
            maxResults: 1000,
            all: true,
          })
          .pipe(
            Stream.flatMap((page) => Stream.fromIterable(page.datasets ?? [])),
            Stream.filter((dataset) => hasAlchemyDatasetLabels(dataset.labels)),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
            Effect.catchTag("NotFound", () =>
              Effect.succeed([] as bigquery.DatasetListDatasetsItem[]),
            ),
          );
        const pages = yield* Effect.forEach(
          datasets,
          (dataset) => {
            const datasetId = dataset.datasetReference?.datasetId;
            if (datasetId === undefined) {
              return Effect.succeed([] as ReturnType<typeof toAttrs>[]);
            }
            return bigquery.listRoutines
              .pages({
                projectId: env.project,
                datasetId,
                maxResults: 1000,
                readMask: "description,routineType,language",
              })
              .pipe(
                Stream.flatMap((page) =>
                  Stream.fromIterable(page.routines ?? []),
                ),
                Stream.filter((routine) =>
                  hasOwnershipMarker(routine.description),
                ),
                Stream.map((routine) => toAttrs(routine, env.project)),
                Stream.runCollect,
                Effect.map((chunk) => Array.from(chunk)),
                Effect.catchTag("NotFound", () =>
                  Effect.succeed([] as ReturnType<typeof toAttrs>[]),
                ),
              );
          },
          { concurrency: 4 },
        );
        return pages.flat();
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const routineId = yield* toId(id, news.routineId, output?.routineId);
      const datasetId = datasetIdOf(news.datasetId);
      const name = resourceName(env.project, datasetId, routineId);
      const internalLabels = yield* createInternalLabels(id);

      let current = yield* getByRef(env.project, datasetId, routineId);
      const userDescription =
        news.description !== undefined
          ? news.description
          : parseDescription(current?.description).description;
      const encodedDescription = encodeDescription(
        internalLabels,
        userDescription,
      );
      const bodyOf = (observed?: bigquery.Routine) =>
        toRoutineBody(
          env.project,
          datasetId,
          routineId,
          news,
          encodedDescription,
          observed,
        );

      if (current === undefined) {
        const created = yield* bigquery
          .insertRoutines({
            projectId: env.project,
            datasetId,
            body: bodyOf(),
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              getByRef(env.project, datasetId, routineId),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new RoutineNotResolved({ name });
      }

      const desired = bodyOf(current);
      const metadataChanged = !jsonEqual(
        inputSnapshot(desired),
        inputSnapshot(current),
      );

      if (metadataChanged) {
        current = yield* bigquery
          .updateRoutines({
            projectId: env.project,
            datasetId,
            routineId,
            body: desired,
          })
          .pipe(
            Effect.catchTag("NotFound", () =>
              bigquery
                .insertRoutines({
                  projectId: env.project,
                  datasetId,
                  body: bodyOf(),
                })
                .pipe(
                  Effect.catchTag("Conflict", () =>
                    getByRef(env.project, datasetId, routineId),
                  ),
                ),
            ),
          );
        if (current === undefined) {
          return yield* new RoutineNotResolved({ name });
        }
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* bigquery
        .deleteRoutines({
          projectId: output.project,
          datasetId: output.datasetId,
          routineId: output.routineId,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
