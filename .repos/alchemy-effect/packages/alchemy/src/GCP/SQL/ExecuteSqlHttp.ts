import * as sqladmin from "@distilled.cloud/gcp/sqladmin_v1";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Output from "../../Output.ts";
import { ExecuteSql, type ExecuteSqlRequest } from "./ExecuteSql.ts";
import type { Instance } from "./Instance.ts";
import { bindGcpHost } from "../Host.ts";
import { grantFor } from "../HttpBinding.ts";

/**
 * HTTP implementation of {@link ExecuteSql}.
 *
 * @layer
 * @provides GCP.SQL.ExecuteSql
 */
export const ExecuteSqlHttp = Layer.effect(
  ExecuteSql,
  Effect.gen(function* () {
    const execute = yield* sqladmin.executeSqlInstances;
    return Effect.fn(function* (instance: Instance) {
      yield* bindGcpHost({
        tag: "GCP.SQL.ExecuteSql",
        resource: instance,
        // Cloud SQL has no instance-level IAM policy; an IAM Condition
        // scopes the project grant to this instance.
        iam: [
          grantFor(
            { role: "roles/cloudsql.instanceUser", scopeByCondition: true },
            Output.interpolate`projects/${instance.project}/instances/${instance.instanceName}`,
          ),
        ],
      });
      const instanceName = yield* instance.instanceName;
      const project = yield* instance.project;
      return Effect.fn(`GCP.SQL.ExecuteSql(${instance.LogicalId})`)(function* (
        request: ExecuteSqlRequest,
      ) {
        return yield* execute({
          ...request,
          instance: yield* instanceName,
          project: yield* project,
        });
      });
    });
  }),
);
