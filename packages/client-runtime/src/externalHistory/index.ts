import {
  type ExternalHistoryMatch,
  type ExternalHistorySource,
  type ExternalHistoryRequest,
  WS_METHODS,
} from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";
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

export function externalHistoryRangeLabel(
  source: {
    readonly textOffset: number;
    readonly text: string;
    readonly totalChars: number;
  },
  resolve: MFunctionType = mFallback,
): string {
  const start = source.text.length === 0 ? source.textOffset : source.textOffset + 1;
  return resolve(msg("Characters {start, number}–{end, number} of {total, number}"), {
    start,
    end: source.textOffset + source.text.length,
    total: source.totalChars,
  });
}

export function externalHistorySearchFilters(
  capabilities: ExternalHistorySource["capabilities"],
  wanted: { readonly filterCwd: string; readonly includeArchived: boolean },
): Pick<Extract<ExternalHistoryRequest, { operation: "search" }>, "filterCwd" | "includeArchived"> {
  return {
    ...(capabilities.cwdFilter && wanted.filterCwd.trim()
      ? { filterCwd: wanted.filterCwd.trim() }
      : {}),
    ...(capabilities.archived ? { includeArchived: wanted.includeArchived } : {}),
  };
}

export function externalHistorySourceStatusLabel(
  status: ExternalHistorySource["status"],
  resolve: MFunctionType = mFallback,
): string {
  return resolve(
    {
      ready: msg("Ready"),
      unavailable: msg("Cannot read"),
      unsupported_format: msg("Unsupported history format"),
    }[status],
  );
}

export function externalHistoryRoleLabel(
  role: ExternalHistoryMatch["role"],
  resolve: MFunctionType = mFallback,
): string {
  return resolve({ user: msg("User"), assistant: msg("Assistant"), tool: msg("Tool") }[role]);
}

export {
  externalHistoryPagingReducer,
  initialExternalHistoryPaging,
} from "./searchPaging.logic.ts";
