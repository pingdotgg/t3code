import type * as runtime from "@cloudflare/workers-types";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  makeKVNamespaceBinding,
  makeKVNamespaceHelpers,
} from "./NamespaceBinding.ts";
import { WriteNamespace, type WriteNamespaceClient } from "./WriteNamespace.ts";

/**
 * Implementation of the {@link WriteNamespace} binding that uses a Worker
 * binding.
 */
export const WriteNamespaceBinding = Layer.effect(
  WriteNamespace,
  Effect.suspend(() =>
    makeKVNamespaceBinding({ makeClient: makeWriteKVClient }),
  ),
);

/** Build the write half of the binding client. */
export const makeWriteKVClient = ({
  use,
}: ReturnType<typeof makeKVNamespaceHelpers>): WriteNamespaceClient => {
  return {
    put: ((...args: Parameters<runtime.KVNamespace["put"]>) =>
      use((raw) => raw.put(...args))) as any,
    delete: ((...args: Parameters<runtime.KVNamespace["delete"]>) =>
      use((raw) => raw.delete(...args))) as any,
  };
};
