import * as sqladmin from "@distilled.cloud/gcp/sqladmin_v1";
import * as Layer from "effect/Layer";
import { makeSqlUserHttpBinding } from "./BindingHttp.ts";
import { GetUser } from "./GetUser.ts";

/**
 * HTTP implementation of {@link GetUser}.
 *
 * @layer
 * @provides GCP.SQL.GetUser
 */
export const GetUserHttp = Layer.effect(
  GetUser,
  makeSqlUserHttpBinding({
    tag: "GCP.SQL.GetUser",
    // `users.get` is not evaluated against the instance's resource name, so
    // an instance-scoped IAM Condition never matches it (observed:
    // SqlInstanceNotAuthorized); no narrower predefined role has it.
    iam: { role: "roles/cloudsql.viewer" },
    operation: sqladmin.getUsers,
  }),
);
