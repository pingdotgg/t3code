import * as datalabeling from "@distilled.cloud/gcp/datalabeling_v1beta1";
import * as Effect from "effect/Effect";
import { waitForOperation as waitForGcpOperation } from "../Operation.ts";
import { noRetryLayer } from "./internal.ts";

const stringField = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

export const resourceNameFromOperation = (
  operation: datalabeling.GoogleLongrunningOperation,
): string | undefined => {
  const response = operation.response;
  const responseName = stringField(response?.name);
  if (responseName !== undefined) {
    return responseName;
  }
  const metadata = operation.metadata;
  const metadataName = stringField(metadata?.name);
  if (metadataName !== undefined) {
    return metadataName;
  }
  const target = stringField(metadata?.target);
  if (target !== undefined) {
    return target;
  }
  return undefined;
};

const getOperation = (name: string) =>
  datalabeling
    .getProjectsOperations({ name })
    .pipe(Effect.provide(noRetryLayer));

/**
 * Wait for an Instruction / feedback-message create operation, then return
 * the finished operation (with its `response`).
 */
export const waitForOperation = (
  operation: datalabeling.GoogleLongrunningOperation,
) =>
  Effect.gen(function* () {
    yield* waitForGcpOperation(operation, getOperation, {
      budget: "10 minutes",
    });
    if (operation.done === true || !operation.name) return operation;
    return yield* getOperation(operation.name);
  });
