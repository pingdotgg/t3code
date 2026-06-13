import type { ObjectRef } from "./Object.ts";

export const namespaceNameOf = (
  namespace: string | { name: string } | ObjectRef,
): string => (typeof namespace === "string" ? namespace : namespace.name);

export const objectNameOf = (
  object: string | { name: string } | ObjectRef,
): string => (typeof object === "string" ? object : object.name);

export const metadataWithNamespace = (
  namespace: string | { name: string } | ObjectRef,
  metadata?: {
    name?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
  },
) => ({
  name: metadata?.name,
  namespace: namespaceNameOf(namespace),
  labels: metadata?.labels,
  annotations: metadata?.annotations,
});
