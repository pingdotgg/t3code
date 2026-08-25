import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output.ts";
import type { Role } from "../IAM/Role.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import type { Datastore } from "./Datastore.ts";

/**
 * Shared scaffolding for AWS HealthImaging (medical-imaging) HTTP bindings.
 *
 * NOT exported from `index.ts` — every `{Op}Http.ts` in this service is a
 * thin `Layer.effect(Cap, make…HttpBinding({ … }))` over one of the builders
 * below. Everything except the operation and the IAM action list is
 * boilerplate: every HealthImaging data-plane operation is scoped to one
 * data store, whose id is injected as `datastoreId` and whose ARN (plus its
 * `…/imageset/*` children — image-set operations are authorized against the
 * image set sub-resource) receives the grant. `StartDICOMImportJob`
 * additionally injects the bound data-access role and a scoped
 * `iam:PassRole` grant.
 */

/**
 * Build the impl Effect for a data-store-scoped HealthImaging operation
 * (image set reads/writes, search, import job describes/lists): the runtime
 * callable injects the bound {@link Datastore}'s id as `datastoreId` and the
 * deploy-time half grants `actions` on the data store ARN and its
 * `…/imageset/*` sub-resources.
 */
export const makeMedicalImagingDatastoreHttpBinding = <
  I extends { datastoreId: string },
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.MedicalImaging.GetImageSet`. */
  tag: string;
  /** The distilled operation; `datastoreId` is injected from the data store. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on the data store ARN + `…/imageset/*`. */
  actions: readonly string[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (datastore: Datastore) {
      const DatastoreId = yield* datastore.datastoreId;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}(${datastore}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.actions],
                Resource: [
                  Output.interpolate`${datastore.datastoreArn}`,
                  Output.interpolate`${datastore.datastoreArn}/imageset/*`,
                ],
              },
            ],
          });
        }
      }
      return Effect.fn(`${options.tag}(${datastore.LogicalId})`)(function* (
        request?: Omit<I, "datastoreId">,
      ) {
        return yield* op({
          ...request,
          datastoreId: yield* DatastoreId,
        } as I);
      });
    });
  });

/**
 * Build the impl Effect for the HealthImaging `StartDICOMImportJob`
 * operation: the binding is constructed with the {@link Datastore} **and the
 * data-access role** (the IAM role HealthImaging assumes to read the DICOM
 * P10 input from S3 and write the import manifests; its trust policy must
 * allow `medical-imaging.amazonaws.com`). The runtime callable injects the
 * data store id as `datastoreId` and the role's ARN as `dataAccessRoleArn`;
 * the deploy-time half grants `actions` on the data store ARN plus
 * `iam:PassRole` on the role — without the PassRole grant, the import fails
 * only at runtime with an AccessDeniedException.
 */
export const makeMedicalImagingStartJobHttpBinding = <
  I extends { datastoreId: string; dataAccessRoleArn: string },
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.MedicalImaging.StartDICOMImportJob`. */
  tag: string;
  /**
   * The distilled operation; `datastoreId` and `dataAccessRoleArn` are
   * injected from the bound resources.
   */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on the data store ARN. */
  actions: readonly string[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (datastore: Datastore, dataAccessRole: Role) {
      const DatastoreId = yield* datastore.datastoreId;
      const RoleArn = yield* dataAccessRole.roleArn;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}(${datastore}, ${dataAccessRole}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: [...options.actions],
                  Resource: [Output.interpolate`${datastore.datastoreArn}`],
                },
                // CRITICAL: without iam:PassRole on the data-access role,
                // StartDICOMImportJob fails only at runtime with an
                // AccessDenied.
                {
                  Effect: "Allow",
                  Action: ["iam:PassRole"],
                  Resource: [Output.interpolate`${dataAccessRole.roleArn}`],
                  Condition: {
                    StringEquals: {
                      "iam:PassedToService": "medical-imaging.amazonaws.com",
                    },
                  },
                },
              ],
            },
          );
        }
      }
      return Effect.fn(`${options.tag}(${datastore.LogicalId})`)(function* (
        request: Omit<I, "datastoreId" | "dataAccessRoleArn"> & {
          dataAccessRoleArn?: string;
        },
      ) {
        return yield* op({
          ...request,
          datastoreId: yield* DatastoreId,
          dataAccessRoleArn: request.dataAccessRoleArn ?? (yield* RoleArn),
        } as I);
      });
    });
  });
