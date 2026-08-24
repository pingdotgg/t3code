import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  makeKVNamespaceBinding,
  type makeKVNamespaceHelpers,
} from "./NamespaceBinding.ts";
import { makeReadKVClient } from "./ReadNamespaceBinding.ts";
import {
  ReadWriteNamespace,
  type ReadWriteNamespaceClient,
} from "./ReadWriteNamespace.ts";
import { makeWriteKVClient } from "./WriteNamespaceBinding.ts";

/**
 * Implementation of the {@link ReadWriteNamespace} binding that uses a
 * Worker binding.
 */
export const ReadWriteNamespaceBinding = Layer.effect(
  ReadWriteNamespace,
  Effect.suspend(() =>
    makeKVNamespaceBinding({ makeClient: makeReadWriteKVClient }),
  ),
);

/** Build the read-write binding client from its read and write halves. */
export const makeReadWriteKVClient = (
  helpers: ReturnType<typeof makeKVNamespaceHelpers>,
): ReadWriteNamespaceClient =>
  ({
    ...makeReadKVClient(helpers),
    ...makeWriteKVClient(helpers),
  }) as ReadWriteNamespaceClient;
