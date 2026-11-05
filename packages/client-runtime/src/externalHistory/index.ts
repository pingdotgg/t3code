import { WS_METHODS } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcQueryAtomFamily } from "../state/runtime.ts";

export function createExternalHistoryAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    query: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "external-history:query",
      tag: WS_METHODS.externalHistoryQuery,
      staleTimeMs: 0,
      idleTtlMs: 0,
    }),
  };
}

export function externalHistoryRangeLabel(source: {
  readonly textOffset: number;
  readonly text: string;
  readonly totalChars: number;
}): string {
  const start = source.text.length === 0 ? source.textOffset : source.textOffset + 1;
  return `Characters ${start.toLocaleString()}–${(source.textOffset + source.text.length).toLocaleString()} of ${source.totalChars.toLocaleString()}`;
}
