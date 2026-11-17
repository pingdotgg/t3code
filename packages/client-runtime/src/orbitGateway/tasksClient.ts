import * as Option from "effect/Option";

import type { OrbitGatewayTransport } from "./client.ts";
import type {
  OrbitTasksClient,
  OrbitTasksErrorReason,
  OrbitTasksInvalidation,
  OrbitTasksListQuery,
  OrbitTasksResult,
} from "./tasks.ts";
import {
  decodeOrbitTaskDetail,
  decodeOrbitTasksErrorEnvelope,
  decodeOrbitTasksPage,
} from "./tasksWire.ts";

const ERROR_REASONS: ReadonlyArray<{
  readonly status: number;
  readonly code: string;
  readonly reason: OrbitTasksErrorReason;
}> = [
  { status: 403, code: "peer.identity_unknown", reason: "not-a-node" },
  { status: 403, code: "node_access.required", reason: "access-required" },
  { status: 409, code: "extension.disabled", reason: "extension-disabled" },
  { status: 404, code: "http.404", reason: "not-found" },
];

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

function listQuery(query: OrbitTasksListQuery): Record<string, string> {
  return Object.fromEntries(
    Object.entries(query).flatMap(([key, value]) =>
      value === undefined ? [] : [[key, String(value)]],
    ),
  );
}

/** Orbit's Conn Tasks reads over any Gateway transport (the desktop main process today). */
export function createOrbitTasksClient(transport: OrbitGatewayTransport): OrbitTasksClient {
  const listeners = new Set<(target: OrbitTasksInvalidation) => void>();

  const read = async <A>(
    path: string,
    query: Record<string, string> | undefined,
    decode: (json: unknown) => A | null,
  ): Promise<OrbitTasksResult<A>> => {
    let response;
    try {
      response = await transport({
        method: "GET",
        path,
        ...(query && Object.keys(query).length > 0 ? { query } : {}),
      });
    } catch (cause) {
      return {
        status: "error",
        reason: "unreachable",
        message: `The Orbit Gateway did not answer: ${cause instanceof Error ? cause.message : String(cause)}`,
      };
    }
    const json = parseJson(response.body);
    if (response.status < 200 || response.status >= 300) {
      const envelope = Option.getOrNull(decodeOrbitTasksErrorEnvelope(json));
      const known = ERROR_REASONS.find(
        (entry) => entry.status === response.status && entry.code === envelope?.error.code,
      );
      return {
        status: "error",
        reason: known?.reason ?? "unreachable",
        message: envelope?.error.message ?? `The Orbit Gateway answered ${response.status}.`,
      };
    }
    const value = decode(json);
    return value === null
      ? {
          status: "error",
          reason: "invalid-response",
          message: `The Orbit Gateway sent an unexpected ${path} response.`,
        }
      : { status: "ok", value };
  };

  return {
    listTasks: (query = {}) => read("/tasks", listQuery(query), decodeOrbitTasksPage),
    getTask: (taskId) => read(`/tasks/${taskId}`, undefined, decodeOrbitTaskDetail),
    invalidate: (target) => {
      for (const listener of listeners) listener(target);
    },
    onInvalidate: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
