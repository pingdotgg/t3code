import {
  type ExecutionRunCreateRequest,
  ExecutionRunCreateResponse,
  type ExecutionRunCreateResponse as ExecutionRunCreateResponseType,
  type ExecutionRunContinueRequest,
  ExecutionRunContinueResponse,
  type ExecutionRunContinueResponse as ExecutionRunContinueResponseType,
  type ExecutionRunInterruptRequest,
  ExecutionRunInterruptResponse,
  type ExecutionRunInterruptResponse as ExecutionRunInterruptResponseType,
  type ExecutionRunStatusQuery,
  ExecutionRunStatusResponse,
  type ExecutionRunStatusResponse as ExecutionRunStatusResponseType,
  type TaskRuntimeMaterializeRequest,
  TaskRuntimeMaterializeResponse,
  type TaskRuntimeMaterializeResponse as TaskRuntimeMaterializeResponseType,
} from "@t3tools/contracts";
import { Schema } from "effect";

const decodeExecutionRunCreateResponse = Schema.decodeUnknownSync(ExecutionRunCreateResponse);
const decodeExecutionRunContinueResponse = Schema.decodeUnknownSync(ExecutionRunContinueResponse);
const decodeExecutionRunInterruptResponse = Schema.decodeUnknownSync(ExecutionRunInterruptResponse);
const decodeExecutionRunStatusResponse = Schema.decodeUnknownSync(ExecutionRunStatusResponse);
const decodeTaskRuntimeMaterializeResponse = Schema.decodeUnknownSync(
  TaskRuntimeMaterializeResponse,
);

function requiredEnv(name: "T3_EXECUTION_BRIDGE_BASE_URL" | "T3_EXECUTION_BRIDGE_SHARED_SECRET") {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required orchestrator environment variable: ${name}`);
  }
  return value;
}

export interface T3ExecutionBridgeClient {
  readonly createExecutionRun: (
    request: ExecutionRunCreateRequest,
  ) => Promise<ExecutionRunCreateResponseType>;
  readonly continueExecutionRun: (
    request: ExecutionRunContinueRequest,
  ) => Promise<ExecutionRunContinueResponseType>;
  readonly interruptExecutionRun: (
    request: ExecutionRunInterruptRequest,
  ) => Promise<ExecutionRunInterruptResponseType>;
  readonly queryRunStatus: (
    query: ExecutionRunStatusQuery,
  ) => Promise<ExecutionRunStatusResponseType>;
  readonly materializeTaskRuntime: (
    request: TaskRuntimeMaterializeRequest,
  ) => Promise<TaskRuntimeMaterializeResponseType>;
}

export function createT3ExecutionBridgeClient(): T3ExecutionBridgeClient {
  const baseUrl = requiredEnv("T3_EXECUTION_BRIDGE_BASE_URL").replace(/\/$/, "");
  const sharedSecret = requiredEnv("T3_EXECUTION_BRIDGE_SHARED_SECRET");

  async function authedPost(path: string, body: unknown) {
    const response = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${sharedSecret}`,
      },
      body: JSON.stringify(body),
    });
    return response;
  }

  return {
    async createExecutionRun(request) {
      const response = await authedPost("/api/execution/runs", request);

      if (!response.ok) {
        const detail = await response.text();
        throw new Error(
          `T3 execution bridge rejected run create (${response.status}): ${detail || "Unknown error"}`,
        );
      }

      return decodeExecutionRunCreateResponse(await response.json());
    },

    async queryRunStatus(query) {
      const response = await authedPost("/api/execution/runs/status", query);

      if (!response.ok) {
        const detail = await response.text();
        throw new Error(
          `T3 execution bridge status query failed (${response.status}): ${detail || "Unknown error"}`,
        );
      }

      return decodeExecutionRunStatusResponse(await response.json());
    },

    async continueExecutionRun(request) {
      const response = await authedPost("/api/execution/runs/continue", request);

      if (!response.ok) {
        const detail = await response.text();
        throw new Error(
          `T3 execution bridge rejected run continue (${response.status}): ${detail || "Unknown error"}`,
        );
      }

      return decodeExecutionRunContinueResponse(await response.json());
    },

    async interruptExecutionRun(request) {
      const response = await authedPost("/api/execution/runs/interrupt", request);

      if (!response.ok) {
        const detail = await response.text();
        throw new Error(
          `T3 execution bridge rejected run interrupt (${response.status}): ${detail || "Unknown error"}`,
        );
      }

      return decodeExecutionRunInterruptResponse(await response.json());
    },

    async materializeTaskRuntime(request) {
      const response = await authedPost("/api/tasks/materialize", request);

      if (!response.ok) {
        const detail = await response.text();
        throw new Error(
          `T3 task runtime bridge rejected materialization (${response.status}): ${detail || "Unknown error"}`,
        );
      }

      return decodeTaskRuntimeMaterializeResponse(await response.json());
    },
  };
}
