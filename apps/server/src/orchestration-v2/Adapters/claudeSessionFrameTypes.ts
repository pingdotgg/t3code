import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import type { ActiveClaudeTurnContext } from "./ClaudeAssistantArtifacts.ts";
import type { ClaudeLiveQueryContext } from "./ClaudeAssistantArtifacts.ts";
import type { ClaudeAgentSdkQuerySession } from "./ClaudeQueryRunnerTypes.ts";

/** One routed SDK frame plus the state resolved for it before any handler runs. */
export interface ClaudeSdkFrame {
  readonly query: ClaudeAgentSdkQuerySession;
  readonly message: SDKMessage;
  readonly replayed: boolean | undefined;
  readonly liveQuery: ClaudeLiveQueryContext;
  readonly context: ActiveClaudeTurnContext;
}
