import * as documentai from "@distilled.cloud/gcp/documentai_v1";
import { waitForOperation as waitForGcpOperation } from "../Operation.ts";

/**
 * Wait for a Document AI long-running operation. Processor create is
 * synchronous; enable, disable, delete, and schema deletes are LROs that
 * finish within a few minutes.
 */
export const waitForOperation = (
  operation: documentai.GoogleLongrunningOperation,
) =>
  waitForGcpOperation(
    operation,
    (name) => documentai.getProjectsLocationsOperations({ name }),
    { budget: "10 minutes" },
  );
