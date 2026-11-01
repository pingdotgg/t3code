import * as parametermanager from "@distilled.cloud/gcp/parametermanager_v1";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  DEFAULT_LOCATION,
  ParameterNotResolved,
  ParameterVersionNotResolved,
  ParameterVersionPayloadRequired,
  desiredPayloadData,
  expandParameter,
  getParameter,
  getVersion,
  hasAlchemyLabelMap,
  lastSegment,
  listAlchemyParameters,
  listVersions,
  locationFromParameter,
  normalizeLocation,
  parseVersionName,
  samePayload,
  toPhysicalId,
  versionResourceName,
  waitUntilVersionGone,
} from "./internal.ts";

export type ParametersVersionProps = {
  /**
   * Parent parameter. Full name
   * `projects/{project}/locations/{location}/parameters/{parameter}`
   * or the parameter id (combined with `location`). Immutable —
   * changing it replaces the version.
   */
  parameter: string;
  /**
   * Parameter Manager location used when `parameter` is a bare id.
   * Immutable — changing it replaces the version. `GLOBAL` is accepted
   * and normalized to `global`.
   * @default "global"
   */
  location?: string;
  /**
   * Version id (the `{version}` segment of
   * `.../parameters/{parameter}/versions/{version}`). If omitted, a
   * unique name is generated from the stack, stage, and logical id.
   * Must be 1-63 characters, start with a letter, and match
   * `[a-zA-Z][a-zA-Z0-9_-]*`. Immutable — changing it replaces the
   * version.
   */
  parameterVersionId?: string;
  /**
   * UTF-8 payload. Alchemy base64-encodes this for the API. Ignored
   * when `payload.data` is set. Immutable — changing it replaces the
   * version.
   */
  data?: string;
  /**
   * Payload as stored by the API. `data` is standard base64. Takes
   * precedence over `data`. Immutable — changing it replaces the
   * version.
   */
  payload?: {
    data?: string;
  };
  /**
   * When true, the version is metadata-only: get always returns the
   * BASIC view and render fails. Mutable.
   * @default false
   */
  disabled?: boolean;
};

export type ParametersVersion = Resource<
  "GCP.ParameterManager.ParametersVersion",
  ParametersVersionProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/parameters/{parameter}/versions/{version}`. */
    name: string;
    /** Version id (last path segment). */
    parameterVersionId: string;
    /** Parent parameter resource name. */
    parameter: string;
    /** Parent parameter id. */
    parameterId: string;
    /** Project id. */
    project: string;
    /** Location id (`us-central1`, `global`, …). */
    location: string;
    /** Standard-base64 payload, when the FULL view returned it. */
    payloadData: string | undefined;
    /** Whether the version is disabled. */
    disabled: boolean;
    /** CMEK key version used to encrypt this payload, if the parent uses CMEK. */
    kmsKeyVersion: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Parameter Manager parameter version — an immutable payload attached
 * to a {@link Parameter}. Versions have no labels field; `list` / nuke
 * find versions whose parent parameter carries Alchemy labels.
 *
 * Changing `parameterVersionId`, `parameter`, `location`, or the payload
 * replaces the version. `disabled` updates in place.
 *
 * ### Creating a ParametersVersion
 * **Example:** UTF-8 payload
 * ```typescript
 * const parameter = yield* GCP.ParameterManager.Parameter("AppConfig", {});
 * const version = yield* GCP.ParameterManager.ParametersVersion("V1", {
 *   parameter: parameter.name,
 *   data: "host=api.example.com",
 * });
 * ```
 *
 * **Example:** JSON payload on a JSON parameter
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
 * ### Disabling a Version
 * **Example:** Keep metadata, hide payload
 * ```typescript
 * const version = yield* GCP.ParameterManager.ParametersVersion("V1", {
 *   parameter: parameter.name,
 *   parameterVersionId: "v1",
 *   data: "host=api.example.com",
 *   disabled: true,
 * });
 * ```
 *
 * @resource
 * @category ParameterManager
 */
export const ParametersVersion = Resource<ParametersVersion>(
  "GCP.ParameterManager.ParametersVersion",
);

export { ParameterVersionNotResolved, ParameterVersionPayloadRequired };

const toAttrs = (
  version: parametermanager.ParameterVersion,
  project: string,
) => {
  const name = version.name ?? "";
  const parsed = parseVersionName(name);
  return {
    name,
    parameterVersionId: parsed.parameterVersionId,
    parameter: parsed.parameter,
    parameterId: lastSegment(parsed.parameter),
    project: parsed.project || project,
    location: parsed.location,
    payloadData: version.payload?.data,
    disabled: version.disabled === true,
    kmsKeyVersion: version.kmsKeyVersion,
    createTime: version.createTime,
    updateTime: version.updateTime,
  };
};

const createBody = (
  payloadData: string,
  disabled: boolean,
): parametermanager.ParameterVersion => ({
  payload: { data: payloadData },
  disabled,
});

export const ParametersVersionProvider = () =>
  Provider.succeed(ParametersVersion, {
    stables: [
      "name",
      "parameterVersionId",
      "parameter",
      "parameterId",
      "project",
      "location",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId = olds?.parameterVersionId ?? output?.parameterVersionId;
      const nextId = news.parameterVersionId ?? previousId;
      const previousParameter = lastSegment(
        olds?.parameter ?? output?.parameter ?? "",
      );
      const nextParameter = lastSegment(news.parameter);
      const previousLocation = normalizeLocation(
        olds?.location ??
          output?.location ??
          locationFromParameter(
            olds?.parameter ?? output?.parameter,
            DEFAULT_LOCATION,
          ),
      );
      const nextLocation = normalizeLocation(
        news.location ??
          locationFromParameter(news.parameter, previousLocation),
      );
      const previousPayload =
        olds?.payload?.data ??
        (olds?.data !== undefined
          ? yield* desiredPayloadData(olds)
          : output?.payloadData);
      const nextPayload = yield* desiredPayloadData(news);
      const idChanged =
        previousId !== undefined &&
        nextId !== undefined &&
        previousId !== nextId;
      const parentChanged =
        previousParameter.length > 0 && previousParameter !== nextParameter;
      const locationChanged = previousLocation !== nextLocation;
      const payloadChanged =
        nextPayload !== undefined &&
        previousPayload !== undefined &&
        !samePayload(previousPayload, nextPayload);
      if (!idChanged && !parentChanged && !locationChanged && !payloadChanged) {
        return undefined;
      }
      return {
        action: "replace" as const,
        deleteFirst:
          !idChanged &&
          !parentChanged &&
          !locationChanged &&
          payloadChanged &&
          previousId !== undefined &&
          nextId === previousId,
      };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        olds?.location ??
          output?.location ??
          locationFromParameter(
            olds?.parameter ?? output?.parameter,
            DEFAULT_LOCATION,
          ),
      );
      const parameter = expandParameter(
        olds?.parameter ?? output?.parameter ?? "",
        env.project,
        location,
      );
      const parameterVersionId = yield* toPhysicalId(
        id,
        olds?.parameterVersionId,
        output?.parameterVersionId,
        "version",
      );
      const name =
        output?.name ?? versionResourceName(parameter, parameterVersionId);
      const existing = yield* getVersion(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      const parent = yield* getParameter(attrs.parameter);
      return hasAlchemyLabelMap(parent?.labels) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const parameters = yield* listAlchemyParameters(env.project);
        const versions = yield* Effect.forEach(
          parameters,
          (parameter) => listVersions(parameter.name ?? ""),
          { concurrency: 4 },
        );
        return versions.flat().map((version) => toAttrs(version, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ??
          output?.location ??
          locationFromParameter(news.parameter, DEFAULT_LOCATION),
      );
      const parameter = expandParameter(news.parameter, env.project, location);
      const parameterVersionId = yield* toPhysicalId(
        id,
        news.parameterVersionId,
        output?.parameterVersionId,
        "version",
      );
      const name = versionResourceName(parameter, parameterVersionId);
      const desiredDisabled = news.disabled === true;
      const desiredPayload = yield* desiredPayloadData(news);

      yield* getParameter(parameter).pipe(
        Effect.flatMap((parent) =>
          parent === undefined
            ? Effect.fail(new ParameterNotResolved({ name: parameter }))
            : Effect.succeed(parent),
        ),
        Effect.retry({
          while: (error) =>
            error._tag === "GCP.ParameterManager.ParameterNotResolved",
          times: 8,
          schedule: Schedule.spaced("1 second"),
        }),
      );

      let current = yield* getVersion(name);

      if (
        current !== undefined &&
        desiredPayload !== undefined &&
        !samePayload(current.payload?.data, desiredPayload)
      ) {
        yield* parametermanager
          .deleteProjectsLocationsParametersVersions({
            name: current.name ?? name,
          })
          .pipe(Effect.catchTag("NotFound", () => Effect.void));
        yield* waitUntilVersionGone(name);
        current = undefined;
      }

      if (current === undefined) {
        if (desiredPayload === undefined) {
          return yield* new ParameterVersionPayloadRequired({ name });
        }
        const created = yield* parametermanager
          .createProjectsLocationsParametersVersions({
            parent: parameter,
            parameterVersionId,
            body: createBody(desiredPayload, desiredDisabled),
          })
          .pipe(
            Effect.retry({
              // The parent parameter may not be readable yet.
              while: (error): boolean => error._tag === "NotFound",
              times: 8,
              schedule: Schedule.spaced("1 second"),
            }),
            Effect.catchTag("Conflict", () => getVersion(name)),
          );
        current = (yield* getVersion(name)) ?? created ?? undefined;
      }

      if (current === undefined) {
        return yield* new ParameterVersionNotResolved({ name });
      }

      if ((current.disabled === true) !== desiredDisabled) {
        yield* parametermanager.patchProjectsLocationsParametersVersions({
          name,
          updateMask: "disabled",
          body: {
            name,
            disabled: desiredDisabled,
          },
        });
        current = (yield* getVersion(name)) ?? current;
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* parametermanager
        .deleteProjectsLocationsParametersVersions({ name: output.name })
        .pipe(
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("1 second"),
          }),
          Effect.catchTag(["NotFound", "BadRequest"], () => Effect.void),
        );
      yield* waitUntilVersionGone(output.name);
    }),
  });
