import type {
  EnvironmentId,
  ModelSelection,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";

export interface McpProviderSessionConfig {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
  /** Latest selection passed to the adapter, not provider-confirmed runtime state. */
  readonly requestedModelSelection?: ModelSelection;
  readonly endpoint: string;
  readonly authorizationHeader: string;
  /** Tool capabilities granted to this provider session. */
  readonly capabilities: ReadonlySet<string>;
  /**
   * Set when the session may drive devices. Adapters spread this into the
   * provider subprocess environment so the `agent-device` CLI is on PATH and
   * already pointed at the server's daemon; the agent never handles a token.
   */
  readonly agentDeviceEnvironment?: Readonly<Record<string, string>>;
}

/** Provider env with the device variables applied over `base`, or `base` untouched. */
export function withAgentDeviceEnvironment(
  base: NodeJS.ProcessEnv,
  config: Pick<McpProviderSessionConfig, "agentDeviceEnvironment"> | undefined,
): NodeJS.ProcessEnv {
  const extra = config?.agentDeviceEnvironment;
  if (!extra) return base;
  const separator = extra.PATH_SEPARATOR ?? ":";
  const basePath = base.PATH ?? base.Path;
  const { PATH: shimDir, PATH_SEPARATOR: _separator, ...rest } = extra;
  return {
    ...base,
    ...rest,
    ...(shimDir ? { PATH: basePath ? `${shimDir}${separator}${basePath}` : shimDir } : {}),
  };
}

interface McpProviderSessionState {
  nextRequestSequence: number;
  acceptedSequence: number;
  acceptedConfig: McpProviderSessionConfig;
  readonly pendingRequests: Map<number, McpProviderSessionConfig>;
}

const sessionsByThread = new Map<ThreadId, McpProviderSessionState>();

export function setMcpProviderSession(config: McpProviderSessionConfig): void {
  sessionsByThread.set(config.threadId, {
    nextRequestSequence: 0,
    acceptedSequence: 0,
    acceptedConfig: config,
    pendingRequests: new Map(),
  });
}

export function readMcpProviderSession(
  threadId: ThreadId,
  options: { readonly includePending?: boolean } = {},
): McpProviderSessionConfig | undefined {
  const session = sessionsByThread.get(threadId);
  if (!session || options.includePending === false) return session?.acceptedConfig;
  let sequence = session.acceptedSequence;
  let config = session.acceptedConfig;
  for (const [pendingSequence, pendingConfig] of session.pendingRequests) {
    if (pendingSequence > sequence) {
      sequence = pendingSequence;
      config = pendingConfig;
    }
  }
  return config;
}

/** Capture provider metadata for one authenticated MCP request. */
export function withMcpRequestedModelSelection(scope: McpInvocationScope): McpInvocationScope {
  const session = readMcpProviderSession(scope.threadId);
  const requestedModelSelection =
    session?.providerSessionId === scope.providerSessionId &&
    session.providerInstanceId === scope.providerInstanceId &&
    session.environmentId === scope.environmentId &&
    session.requestedModelSelection?.instanceId === scope.providerInstanceId
      ? session.requestedModelSelection
      : null;
  return { ...scope, requestedModelSelection };
}

/**
 * Publish the selection during a provider request, then settle it on exit. Start
 * order wins over completion order; failed requests never become rollback targets.
 */
export function beginMcpModelSelectionRequest(
  threadId: ThreadId,
  providerInstanceId: ProviderInstanceId,
  selection: ModelSelection | undefined,
): ((succeeded: boolean) => void) | undefined {
  const session = sessionsByThread.get(threadId);
  if (
    !session ||
    session.acceptedConfig.providerInstanceId !== providerInstanceId ||
    selection?.instanceId !== providerInstanceId
  )
    return undefined;
  const sequence = ++session.nextRequestSequence;
  const config = { ...session.acceptedConfig, requestedModelSelection: selection };
  session.pendingRequests.set(sequence, config);
  return (succeeded) => {
    if (sessionsByThread.get(threadId) !== session || !session.pendingRequests.delete(sequence))
      return;
    if (succeeded && sequence > session.acceptedSequence) {
      session.acceptedSequence = sequence;
      session.acceptedConfig = config;
    }
  };
}

export function clearMcpProviderSession(threadId: ThreadId): void {
  sessionsByThread.delete(threadId);
}

export function clearAllMcpProviderSessions(): void {
  sessionsByThread.clear();
}
