import * as dax from "@distilled.cloud/aws/dax";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";

export interface ParameterGroupProps {
  /**
   * Name of the parameter group. If omitted, a deterministic physical name
   * is generated. Changing the name replaces the parameter group.
   */
  parameterGroupName?: string;
  /**
   * Human-readable description of the parameter group.
   */
  description?: string;
  /**
   * Parameter overrides, e.g. `{ "query-ttl-millis": "60000" }`. DAX exposes
   * two tunable parameters: `query-ttl-millis` and `record-ttl-millis`.
   * DAX has no reset-to-default API, so a key removed from this map keeps
   * its last applied value.
   */
  parameters?: Record<string, string>;
}

export interface ParameterGroup extends Resource<
  "AWS.DAX.ParameterGroup",
  ParameterGroupProps,
  {
    /** Name of the parameter group. */
    parameterGroupName: string;
    /** Description of the parameter group. */
    description: string | undefined;
    /** Current non-default parameter values, keyed by parameter name. */
    parameters: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A DAX parameter group — a named set of DAX engine parameters (item and
 * query cache TTLs) that can be attached to one or more DAX
 * {@link Cluster}s.
 *
 * Parameter groups are free and provision instantly. DAX does not support
 * tags on parameter groups.
 * @resource
 * @section Creating a Parameter Group
 * @example Parameter Group with Custom Cache TTLs
 * ```typescript
 * const params = yield* ParameterGroup("DaxParams", {
 *   description: "5 minute item and query TTLs",
 *   parameters: {
 *     "query-ttl-millis": "300000",
 *     "record-ttl-millis": "300000",
 *   },
 * });
 * ```
 *
 * @section Attaching to a Cluster
 * @example Cluster Using the Parameter Group
 * ```typescript
 * const cluster = yield* Cluster("Cache", {
 *   nodeType: "dax.t3.small",
 *   replicationFactor: 1,
 *   iamRoleArn: role.roleArn,
 *   parameterGroupName: params.parameterGroupName,
 * });
 * ```
 */
export const ParameterGroup = Resource<ParameterGroup>(
  "AWS.DAX.ParameterGroup",
);

export const ParameterGroupProvider = () =>
  Provider.effect(
    ParameterGroup,
    Effect.gen(function* () {
      const toName = (id: string, props: ParameterGroupProps) =>
        props.parameterGroupName
          ? Effect.succeed(props.parameterGroupName)
          : createPhysicalName({ id, maxLength: 255, lowercase: true });

      const readGroup = Effect.fn(function* (name: string) {
        const response = yield* dax
          .describeParameterGroups({ ParameterGroupNames: [name] })
          .pipe(
            Effect.catchTag("ParameterGroupNotFoundFault", () =>
              Effect.succeed(undefined),
            ),
          );
        return response?.ParameterGroups?.[0];
      });

      // Observed parameter values for the group (bounded pagination — DAX
      // has no paginated distilled ops).
      const readParameters = Effect.fn(function* (name: string) {
        const values: Record<string, string> = {};
        let nextToken: string | undefined;
        for (let page = 0; page < 20; page++) {
          const response = yield* dax.describeParameters({
            ParameterGroupName: name,
            NextToken: nextToken,
          });
          for (const parameter of response.Parameters ?? []) {
            if (
              parameter.ParameterName !== undefined &&
              parameter.ParameterValue !== undefined
            ) {
              values[parameter.ParameterName] = parameter.ParameterValue;
            }
          }
          nextToken = response.NextToken;
          if (!nextToken) break;
        }
        return values;
      });

      const toAttrs = (
        group: dax.ParameterGroup,
        parameters: Record<string, string>,
        overrides: Record<string, string> | undefined,
      ) => ({
        parameterGroupName: group.ParameterGroupName ?? "",
        description: group.Description,
        // Report only the user's overridden keys with their observed values,
        // not the entire engine parameter list.
        parameters: Object.fromEntries(
          Object.keys(overrides ?? {}).map((key) => [
            key,
            parameters[key] ?? "",
          ]),
        ),
      });

      return {
        stables: ["parameterGroupName"],

        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return undefined;
          if (
            (yield* toName(id, olds ?? {})) !== (yield* toName(id, news ?? {}))
          ) {
            return { action: "replace" } as const;
          }
        }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const name =
            output?.parameterGroupName ?? (yield* toName(id, olds ?? {}));
          const group = yield* readGroup(name);
          if (group?.ParameterGroupName === undefined) return undefined;
          const parameters = yield* readParameters(name);
          // DAX parameter groups do not support tags, so ownership cannot be
          // verified — return the attributes directly.
          return toAttrs(group, parameters, olds?.parameters);
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const props = news ?? {};
          const name = output?.parameterGroupName ?? (yield* toName(id, props));

          // 1. Observe — cloud state is authoritative.
          let observed = yield* readGroup(name);

          // 2. Ensure — create if missing; tolerate AlreadyExists as a race.
          if (observed === undefined) {
            yield* dax
              .createParameterGroup({
                ParameterGroupName: name,
                Description: props.description,
              })
              .pipe(
                Effect.catchTag(
                  "ParameterGroupAlreadyExistsFault",
                  () => Effect.void,
                ),
              );
            observed = yield* readGroup(name);
          }
          if (observed === undefined) {
            return yield* Effect.fail(
              new Error(`DAX parameter group '${name}' not found after create`),
            );
          }

          // 3. Sync parameters — diff desired overrides against OBSERVED
          // values and apply only the delta. (Description is create-only in
          // the DAX API — UpdateParameterGroup accepts only parameter
          // values.)
          const observedParameters = yield* readParameters(name);
          const delta = Object.entries(props.parameters ?? {}).filter(
            ([key, value]) => observedParameters[key] !== value,
          );
          if (delta.length > 0) {
            yield* dax.updateParameterGroup({
              ParameterGroupName: name,
              ParameterNameValues: delta.map(
                ([ParameterName, ParameterValue]) => ({
                  ParameterName,
                  ParameterValue,
                }),
              ),
            });
            for (const [key, value] of delta) {
              observedParameters[key] = value;
            }
          }

          yield* session.note(name);
          return toAttrs(observed, observedParameters, props.parameters);
        }),

        delete: Effect.fn(function* ({ output }) {
          // A parameter group still attached to a cluster rejects deletion
          // with InvalidParameterGroupStateFault — retry (bounded) while the
          // cluster releases it. NotFound is success (idempotent delete).
          yield* dax
            .deleteParameterGroup({
              ParameterGroupName: output.parameterGroupName,
            })
            .pipe(
              Effect.catchTag("ParameterGroupNotFoundFault", () => Effect.void),
              Effect.retry({
                while: (e) => e._tag === "InvalidParameterGroupStateFault",
                schedule: Schedule.max([
                  Schedule.fixed("5 seconds"),
                  Schedule.recurs(10),
                ]),
              }),
            );
        }),

        list: () =>
          Effect.gen(function* () {
            // Bounded hand-rolled pagination (no distilled paginator).
            const groups: dax.ParameterGroup[] = [];
            let nextToken: string | undefined;
            for (let page = 0; page < 20; page++) {
              const response = yield* dax.describeParameterGroups({
                NextToken: nextToken,
              });
              groups.push(...(response.ParameterGroups ?? []));
              nextToken = response.NextToken;
              if (!nextToken) break;
            }
            return groups
              .filter(
                (group) =>
                  group.ParameterGroupName !== undefined &&
                  // AWS-managed default parameter groups (`default.dax1.0`,
                  // …) always exist and can never be deleted — keep them out
                  // of enumeration for account-wide teardown (nuke).
                  !group.ParameterGroupName.startsWith("default."),
              )
              .map((group) => toAttrs(group, {}, undefined));
          }),
      };
    }),
  );
