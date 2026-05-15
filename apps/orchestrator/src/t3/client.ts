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
  type TaskRuntimeUserInputRespondRequest,
  TaskRuntimeUserInputRespondResponse,
  type TaskRuntimeUserInputRespondResponse as TaskRuntimeUserInputRespondResponseType,
  type TaskPullRequestEnsureRequest,
  TaskPullRequestEnsureResponse,
  type TaskPullRequestEnsureResponse as TaskPullRequestEnsureResponseType,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const decodeExecutionRunCreateResponse = Schema.decodeUnknownSync(ExecutionRunCreateResponse);
const decodeExecutionRunContinueResponse = Schema.decodeUnknownSync(ExecutionRunContinueResponse);
const decodeExecutionRunInterruptResponse = Schema.decodeUnknownSync(ExecutionRunInterruptResponse);
const decodeExecutionRunStatusResponse = Schema.decodeUnknownSync(ExecutionRunStatusResponse);
const decodeTaskRuntimeMaterializeResponse = Schema.decodeUnknownSync(
  TaskRuntimeMaterializeResponse,
);
const decodeTaskPullRequestEnsureResponse = Schema.decodeUnknownSync(TaskPullRequestEnsureResponse);
const decodeTaskRuntimeUserInputRespondResponse = Schema.decodeUnknownSync(
  TaskRuntimeUserInputRespondResponse,
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
  readonly ensureTaskPullRequest: (
    request: TaskPullRequestEnsureRequest,
  ) => Promise<TaskPullRequestEnsureResponseType>;
  readonly respondToTaskRuntimeUserInput: (
    request: TaskRuntimeUserInputRespondRequest,
  ) => Promise<TaskRuntimeUserInputRespondResponseType>;
}

export interface T3ExecutionBridgeClientOptions {
  readonly baseUrl?: string | undefined;
}

export function createT3ExecutionBridgeClient(
  options: T3ExecutionBridgeClientOptions = {},
): T3ExecutionBridgeClient {
  const baseUrl = (options.baseUrl ?? requiredEnv("T3_EXECUTION_BRIDGE_BASE_URL")).replace(
    /\/$/,
    "",
  );
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

    async ensureTaskPullRequest(request) {
      const response = await authedPost("/api/tasks/pull-request/ensure", request);

      if (!response.ok) {
        const detail = await response.text();
        throw new Error(
          `T3 task runtime bridge rejected pull request ensure (${response.status}): ${detail || "Unknown error"}`,
        );
      }

      return decodeTaskPullRequestEnsureResponse(await response.json());
    },

    async respondToTaskRuntimeUserInput(request) {
      const response = await authedPost("/api/tasks/user-input/respond", request);

      if (!response.ok) {
        const detail = await response.text();
        throw new Error(
          `T3 task runtime bridge rejected user input response (${response.status}): ${detail || "Unknown error"}`,
        );
      }

      return decodeTaskRuntimeUserInputRespondResponse(await response.json());
    },
  };
}
