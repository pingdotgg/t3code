import { ExtensionError } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const isExtensionError = Schema.is(ExtensionError);

export const extensionFailureReason = (cause: unknown) =>
  isExtensionError(cause) ? cause.reason : "runtime-failed";
