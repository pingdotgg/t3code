import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type ModelSelection,
} from "@t3tools/contracts";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  beginMcpModelSelectionRequest,
  clearAllMcpProviderSessions,
  clearMcpProviderSession,
  readMcpProviderSession,
  setMcpProviderSession,
  withAgentDeviceEnvironment,
  type McpProviderSessionConfig,
} from "./McpProviderSession.ts";

describe("device CLI environment", () => {
  it("preserves provider credentials and commands while routing devices to the owned daemon", () => {
    const environment = withAgentDeviceEnvironment(
      { PATH: "/provider/bin:/usr/bin", PROVIDER_KEY: "fixture" },
      {
        agentDeviceEnvironment: {
          PATH: "/t3/device/bin",
          PATH_SEPARATOR: ":",
          AGENT_DEVICE_DAEMON_BASE_URL: "http://127.0.0.1:9000",
          AGENT_DEVICE_DAEMON_AUTH_TOKEN: "fixture-device",
        },
      },
    );
    expect(environment).toEqual({
      PATH: "/t3/device/bin:/provider/bin:/usr/bin",
      PROVIDER_KEY: "fixture",
      AGENT_DEVICE_DAEMON_BASE_URL: "http://127.0.0.1:9000",
      AGENT_DEVICE_DAEMON_AUTH_TOKEN: "fixture-device",
    });
  });

  it("does not grant CLI access when device access was not supplied", () => {
    const environment = { PATH: "/usr/bin", PROVIDER_KEY: "fixture" };
    expect(withAgentDeviceEnvironment(environment, undefined)).toBe(environment);
    expect(withAgentDeviceEnvironment(environment, {})).toBe(environment);
  });
});

const threadId = ThreadId.make("thread-model-requests");
const providerInstanceId = ProviderInstanceId.make("codex");
const selection = (model: string): ModelSelection => ({ instanceId: providerInstanceId, model });
const initialConfig: McpProviderSessionConfig = {
  environmentId: EnvironmentId.make("environment-model-requests"),
  threadId,
  providerInstanceId,
  providerSessionId: "session-original",
  endpoint: "http://localhost/mcp",
  authorizationHeader: "Bearer original",
  capabilities: new Set(["thread"]),
  requestedModelSelection: selection("initial"),
};
const currentModel = () => readMcpProviderSession(threadId)?.requestedModelSelection?.model;
const beginRequest = (model: string) => {
  const complete = beginMcpModelSelectionRequest(threadId, providerInstanceId, selection(model));
  expect(complete).toBeDefined();
  return complete!;
};

afterEach(clearAllMcpProviderSessions);

describe("MCP model request metadata", () => {
  it.each(["first", "second"] as const)(
    "restores the accepted selection when both overlapping requests fail, %s finishes first",
    (firstToFinish) => {
      setMcpProviderSession(initialConfig);
      const first = beginRequest("first");
      const second = beginRequest("second");
      expect(currentModel()).toBe("second");
      if (firstToFinish === "first") {
        first(false);
        expect(currentModel()).toBe("second");
        second(false);
      } else {
        second(false);
        expect(currentModel()).toBe("first");
        first(false);
      }
      expect(readMcpProviderSession(threadId)).toBe(initialConfig);
    },
  );

  it.each([
    { firstSucceeds: true, firstCompletesFirst: true, expected: "first" },
    { firstSucceeds: true, firstCompletesFirst: false, expected: "first" },
    { firstSucceeds: false, firstCompletesFirst: true, expected: "second" },
    { firstSucceeds: false, firstCompletesFirst: false, expected: "second" },
  ])(
    "retains only the successful request: %j",
    ({ firstSucceeds, firstCompletesFirst, expected }) => {
      setMcpProviderSession(initialConfig);
      const first = beginRequest("first");
      const second = beginRequest("second");
      if (firstCompletesFirst) {
        first(firstSucceeds);
        expect(currentModel()).toBe("second");
        second(!firstSucceeds);
      } else {
        second(!firstSucceeds);
        expect(currentModel()).toBe(firstSucceeds ? "first" : "second");
        first(firstSucceeds);
      }
      expect(currentModel()).toBe(expected);
    },
  );

  it("does not let an older pending request or late success override a newer success", () => {
    setMcpProviderSession(initialConfig);
    const first = beginRequest("first");
    const second = beginRequest("second");
    second(true);
    expect(currentModel()).toBe("second");
    first(true);
    expect(currentModel()).toBe("second");
    // Duplicate completion cannot roll back a request already settled.
    second(false);
    expect(currentModel()).toBe("second");
    const third = beginRequest("third");
    expect(currentModel()).toBe("third");
    expect(
      readMcpProviderSession(threadId, { includePending: false })?.requestedModelSelection?.model,
    ).toBe("second");
    third(false);
    expect(currentModel()).toBe("second");
    expect(readMcpProviderSession(threadId)).toMatchObject({
      providerSessionId: initialConfig.providerSessionId,
      authorizationHeader: initialConfig.authorizationHeader,
      endpoint: initialConfig.endpoint,
    });
  });

  it("ignores completions after the session has been replaced or cleared", () => {
    setMcpProviderSession(initialConfig);
    const first = beginRequest("first");
    const second = beginRequest("second");
    const replacement = {
      ...initialConfig,
      providerSessionId: "replacement",
      requestedModelSelection: selection("replacement"),
    };
    setMcpProviderSession(replacement);
    first(false);
    second(true);
    expect(readMcpProviderSession(threadId)).toBe(replacement);
    const third = beginRequest("third");
    clearMcpProviderSession(threadId);
    third(true);
    expect(readMcpProviderSession(threadId)).toBeUndefined();
  });

  it("ignores absent selections and requests belonging to another provider instance", () => {
    setMcpProviderSession(initialConfig);
    const other = ProviderInstanceId.make("other");
    expect(beginMcpModelSelectionRequest(threadId, providerInstanceId, undefined)).toBeUndefined();
    expect(beginMcpModelSelectionRequest(threadId, other, selection("first"))).toBeUndefined();
    expect(
      beginMcpModelSelectionRequest(threadId, providerInstanceId, {
        instanceId: other,
        model: "other",
      }),
    ).toBeUndefined();
    expect(readMcpProviderSession(threadId)).toBe(initialConfig);
  });
});
