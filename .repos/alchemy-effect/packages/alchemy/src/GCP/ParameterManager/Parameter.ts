import * as parametermanager from "@distilled.cloud/gcp/parametermanager_v1";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import {
  createInternalLabels,
  diffLabels,
  hasAlchemyLabels,
  toLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  ParameterNotResolved,
  deleteVersions,
  getParameter,
  lastSegment,
  listAlchemyParameters,
  normalizeFormat,
  normalizeLocation,
  parameterResourceName,
  parseParameterName,
  sameText,
  toPhysicalId,
  userLabels,
  waitUntilParameterGone,
} from "./internal.ts";

export type ParameterFormat =
  | parametermanager.ParameterFormatEnum
  | (string & {});

export type ParameterProps = {
  /**
   * Parameter id (the `{parameter}` segment of
   * `projects/{project}/locations/{location}/parameters/{parameter}`).
   * If omitted, a unique name is generated from the stack, stage, and
   * logical id. Must be 1-63 characters, start with a letter, and match
   * `[a-zA-Z][a-zA-Z0-9_-]*`. Immutable — changing it replaces the
   * parameter.
   */
  parameterId?: string;
  /**
   * Parameter Manager location (`global`, `us-central1`, …). Immutable —
   * changing it replaces the parameter. `GLOBAL` is accepted and
   * normalized to `global`. Regional locations require Parameter Manager
   * regional access on the project.
   * @default "global"
   */
  location?: string;
  /**
   * Payload format. Immutable — changing it replaces the parameter. The
   * API defaults unspecified values to `UNFORMATTED`. `JSON` and `YAML`
   * enable secret-reference rendering on versions.
   * @default "UNFORMATTED"
   */
  format?: ParameterFormat;
  /**
   * Cloud KMS CryptoKey used to encrypt versions
   * (`projects/{project}/locations/{location}/keyRings/{keyRing}/cryptoKeys/{cryptoKey}`).
   * Must live in the same location as the parameter. Empty or omitted
   * uses Google-managed encryption. Mutable.
   */
  kmsKey?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
};

export type Parameter = Resource<
  "GCP.ParameterManager.Parameter",
  ParameterProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/parameters/{parameter}`. */
    name: string;
    /** Parameter id (last path segment). */
    parameterId: string;
    /** Project id. */
    project: string;
    /** Location id (`us-central1`, `global`, …). */
    location: string;
    /** Payload format (`UNFORMATTED`, `YAML`, `JSON`). */
    format: string;
    /** CMEK resource name, if set. */
    kmsKey: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** IAM policy member for the user-assigned name. */
    iamPolicyNamePrincipal: string | undefined;
    /** IAM policy member for the system-assigned uid. */
    iamPolicyUidPrincipal: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Parameter Manager parameter — metadata and encryption for versioned
 * payloads. Version data lives on {@link ParametersVersion}.
 *
 * Changing `parameterId`, `location`, or `format` replaces the parameter.
 * Labels and `kmsKey` update in place.
 *
 * ### Creating a Parameter
 * **Example:** Generated name
 * ```typescript
 * const parameter = yield* GCP.ParameterManager.Parameter("AppConfig", {});
 * ```
 *
 * **Example:** Explicit id, format, and labels
 * ```typescript
 * const parameter = yield* GCP.ParameterManager.Parameter("AppConfig", {
 *   parameterId: "order-config",
 *   format: "JSON",
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * ### Parameter Versions
 * **Example:** Store a JSON payload
 * ```typescript
 * const parameter = yield* GCP.ParameterManager.Parameter("AppConfig", {
 *   format: "JSON",
 * });
 * const version = yield* GCP.ParameterManager.ParametersVersion("V1", {
 *   parameter: parameter.name,
 *   data: JSON.stringify({ host: "api.example.com" }),
 * });
 * ```
 *
 * @resource
 * @category ParameterManager
 */
export const Parameter = Resource<Parameter>("GCP.ParameterManager.Parameter");

export { ParameterNotResolved };

const toAttrs = (parameter: parametermanager.Parameter, project: string) => {
  const name = parameter.name ?? "";
  const parsed = parseParameterName(name);
  return {
    name,
    parameterId: parsed.parameterId,
    project: parsed.project || project,
    location: parsed.location,
    format: normalizeFormat(parameter.format),
    kmsKey: parameter.kmsKey,
    labels: userLabels(parameter.labels),
    iamPolicyNamePrincipal: parameter.policyMember?.iamPolicyNamePrincipal,
    iamPolicyUidPrincipal: parameter.policyMember?.iamPolicyUidPrincipal,
    createTime: parameter.createTime,
    updateTime: parameter.updateTime,
  };
};

export const ParameterProvider = () =>
  Provider.succeed(Parameter, {
    stables: [
      "name",
      "parameterId",
      "project",
      "location",
      "format",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId = olds?.parameterId ?? output?.parameterId;
      const nextId = news.parameterId ?? previousId;
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
      );
      const nextLocation = normalizeLocation(
        news.location ?? olds?.location ?? output?.location,
      );
      const previousFormat = normalizeFormat(olds?.format ?? output?.format);
      const nextFormat = normalizeFormat(
        news.format ?? olds?.format ?? output?.format,
      );
      const idChanged =
        previousId !== undefined &&
        nextId !== undefined &&
        previousId !== nextId;
      const locationChanged = previousLocation !== nextLocation;
      const formatChanged = previousFormat !== nextFormat;
      if (!idChanged && !locationChanged && !formatChanged) return undefined;
      return {
        action: "replace" as const,
        deleteFirst:
          !idChanged &&
          !locationChanged &&
          formatChanged &&
          previousId !== undefined &&
          nextId === previousId,
      };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const parameterId = yield* toPhysicalId(
        id,
        olds?.parameterId,
        output?.parameterId,
        "parameter",
      );
      const location = normalizeLocation(olds?.location ?? output?.location);
      const name =
        output?.name ??
        parameterResourceName(env.project, location, parameterId);
      const existing = yield* getParameter(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const parameters = yield* listAlchemyParameters(env.project);
        return parameters.map((parameter) => toAttrs(parameter, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const parameterId = yield* toPhysicalId(
        id,
        news.parameterId,
        output?.parameterId,
        "parameter",
      );
      const location = normalizeLocation(news.location ?? output?.location);
      const format = normalizeFormat(news.format ?? output?.format);
      const name = parameterResourceName(env.project, location, parameterId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const desiredKmsKey = news.kmsKey ?? "";

      let current = yield* getParameter(name);

      if (current !== undefined && normalizeFormat(current.format) !== format) {
        yield* deleteVersions(current.name ?? name);
        yield* parametermanager
          .deleteProjectsLocationsParameters({ name: current.name ?? name })
          .pipe(Effect.catchTag("NotFound", () => Effect.void));
        yield* waitUntilParameterGone(name);
        current = undefined;
      }

      if (current === undefined) {
        const created = yield* parametermanager
          .createProjectsLocationsParameters({
            parent: `projects/${env.project}/locations/${location}`,
            parameterId,
            body: {
              labels: desiredLabels,
              format,
              kmsKey: news.kmsKey,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => getParameter(name)));
        current = (yield* getParameter(name)) ?? created ?? undefined;
      }

      if (current === undefined) {
        return yield* new ParameterNotResolved({ name });
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const kmsChanged = !sameText(current.kmsKey, desiredKmsKey);

      if (labelsChanged || kmsChanged) {
        yield* parametermanager.patchProjectsLocationsParameters({
          name,
          updateMask: [
            labelsChanged ? "labels" : undefined,
            kmsChanged ? "kmsKey" : undefined,
          ]
            .filter((field): field is string => field !== undefined)
            .join(","),
          body: {
            name,
            labels: desiredLabels,
            kmsKey: news.kmsKey,
          },
        });
        current = (yield* getParameter(name)) ?? current;
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const name = output.name;
      yield* deleteVersions(name);
      yield* parametermanager.deleteProjectsLocationsParameters({ name }).pipe(
        Effect.retry({
          while: (error) => error._tag === "Conflict",
          times: 8,
          schedule: Schedule.spaced("1 second"),
        }),
        Effect.catchTag(["NotFound", "BadRequest"], () => Effect.void),
      );
      yield* waitUntilParameterGone(name);
    }),
  });

export const parameterIdOf = (name: string) => lastSegment(name);
