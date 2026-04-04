import React, { useCallback, useRef, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { WelcomeScreen } from "./components/WelcomeScreen.tsx";
import { ChatView } from "./components/ChatView.tsx";
import { ExecutionView } from "./components/ExecutionView.tsx";
import { DiffView } from "./components/DiffView.tsx";
import { CommandApprovalView } from "./components/CommandApprovalView.tsx";
import { Header } from "./components/Header.tsx";
import type { ClaudeAdapter } from "../adapters/claude-adapter.ts";
import type { FileAdapter } from "../adapters/file-adapter.ts";
import type { SessionManager } from "../session/SessionManager.ts";
import { ToolHandler } from "../tools/handler.ts";
import { CLI_TOOLS } from "../tools/definitions.ts";
import type { WorkspaceContext } from "../adapters/file-adapter.ts";
import type { CodeSession, FileChange, Message, ToolUse } from "../types.ts";

// Single discriminated union prevents mode/changes from ever being out of sync
type AppState =
  | { mode: "welcome" }
  | { mode: "chat" }
  | { mode: "executing"; step: string; streamedText: string }
  | { mode: "diff"; changes: FileChange[] }
  | { mode: "command_approval"; command: string; description: string }
  | { mode: "done" };

interface Props {
  fileAdapter: FileAdapter;
  claudeAdapter: ClaudeAdapter;
  sessionManager: SessionManager;
  context: WorkspaceContext;
  model: string;
  initialSession?: CodeSession;
}

export const MainApp: React.FC<Props> = ({
  fileAdapter,
  claudeAdapter,
  sessionManager,
  context,
  model,
  initialSession,
}) => {
  useApp(); // keep app alive
  const [state, setState] = useState<AppState>(
    initialSession ? { mode: "chat" } : { mode: "welcome" },
  );
  const [messages, setMessages] = useState<Message[]>(
    initialSession?.messages ?? [],
  );
  const messagesRef = useRef<Message[]>(initialSession?.messages ?? []);

  // Restore full API history (including tool_use/tool_result blocks) if available
  React.useEffect(() => {
    if (initialSession?.apiHistory) {
      claudeAdapter.setApiHistory(initialSession.apiHistory);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const commandApprovalRef = useRef<((approved: boolean) => void) | null>(null);

  useInput((_input, key) => {
    if (key.ctrl && _input === "r" && state.mode === "chat") {
      messagesRef.current = [];
      setMessages([]);
      claudeAdapter.setApiHistory([]);
      sessionManager.clear();
    }
  });

  const handleUserMessage = useCallback(
    async (userText: string) => {
      const userMsg: Message = {
        role: "user",
        content: userText,
        timestamp: Date.now(),
      };
      const updated = [...messagesRef.current, userMsg];
      messagesRef.current = updated;
      setMessages(updated);
      setState({ mode: "executing", step: "Thinking...", streamedText: "" });

      const queuedChanges: FileChange[] = [];
      const toolHandlerInstance = new ToolHandler(
        fileAdapter,
        (change) => { queuedChanges.push(change); },
        (command, description) =>
          new Promise((resolve) => {
            commandApprovalRef.current = resolve;
            setState({ mode: "command_approval", command, description });
          }),
      );

      const usedTools: ToolUse[] = [];
      let responseText = "";

      try {
        for await (const event of claudeAdapter.streamCodeGeneration(
          updated,
          context.workingDirectory,
          model,
          CLI_TOOLS,
          async (toolUse) => {
            setState((prev) =>
              prev.mode === "executing"
                ? { ...prev, step: `Running: ${toolUse.name}` }
                : prev,
            );
            const result = await toolHandlerInstance.handle(toolUse);
            return result.content;
          },
        )) {
          if (event.type === "text") {
            responseText += event.text;
            setState((prev) =>
              prev.mode === "executing"
                ? { ...prev, step: "Responding...", streamedText: responseText }
                : prev,
            );
          } else if (event.type === "tool_use") {
            usedTools.push(event.toolUse);
          }
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        const errResponse: Message = {
          role: "assistant",
          content: `Error: ${errMsg}`,
          timestamp: Date.now(),
        };
        const withErr = [...messagesRef.current, errResponse];
        messagesRef.current = withErr;
        setMessages(withErr);
        setState({ mode: "chat" });
        return;
      }

      const assistantMsg: Message = {
        role: "assistant",
        content: responseText,
        timestamp: Date.now(),
        ...(usedTools.length > 0 && { toolUse: usedTools }),
      };
      const withResponse = [...messagesRef.current, assistantMsg];
      messagesRef.current = withResponse;
      setMessages(withResponse);

      sessionManager.save({
        messages: withResponse,
        apiHistory: claudeAdapter.getApiHistory(),
        workingDirectory: context.workingDirectory,
        currentTask: userText,
        savedAt: Date.now(),
      });

      // Atomic: diff mode always carries its changes
      if (queuedChanges.length > 0) {
        setState({ mode: "diff", changes: queuedChanges });
      } else {
        setState({ mode: "chat" });
      }
    },
    [claudeAdapter, context.workingDirectory, fileAdapter, model, sessionManager],
  );

  const handleApprove = useCallback(
    async (approved: FileChange[]) => {
      for (const change of approved) {
        if (change.type === "delete") {
          await fileAdapter.delete(change.path);
        } else if (change.type === "move" && change.destPath) {
          await fileAdapter.move(change.path, change.destPath);
        } else if (change.newContent !== undefined) {
          await fileAdapter.write(change.path, change.newContent);
        }
      }
      setState({ mode: "done" });
      setTimeout(() => setState({ mode: "chat" }), 1500);
    },
    [fileAdapter],
  );

  const handleCommandApprove = useCallback(() => {
    commandApprovalRef.current?.(true);
    commandApprovalRef.current = null;
    setState({ mode: "executing", step: "Running command...", streamedText: "" });
  }, []);

  const handleCommandReject = useCallback(() => {
    commandApprovalRef.current?.(false);
    commandApprovalRef.current = null;
    setState({ mode: "executing", step: "Responding...", streamedText: "" });
  }, []);

  const handleReject = useCallback(() => {
    setState({ mode: "chat" });
  }, []);

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      <Header
        workingDir={context.workingDirectory}
        fileCount={context.files.length}
      />

      {state.mode === "welcome" && (
        <WelcomeScreen onReady={() => setState({ mode: "chat" })} />
      )}

      {state.mode === "chat" && (
        <ChatView
          messages={messages}
          isExecuting={false}
          onSubmit={handleUserMessage}
        />
      )}

      {state.mode === "executing" && (
        <ExecutionView
          step={state.step}
          streamedText={state.streamedText}
        />
      )}

      {state.mode === "diff" && (
        <DiffView
          changes={state.changes}
          onApprove={handleApprove}
          onReject={handleReject}
        />
      )}

      {state.mode === "command_approval" && (
        <CommandApprovalView
          command={state.command}
          description={state.description}
          onApprove={handleCommandApprove}
          onReject={handleCommandReject}
        />
      )}

      {state.mode === "done" && (
        <Box>
          <Text color="green">✓ Changes applied. Continuing...</Text>
        </Box>
      )}
    </Box>
  );
};
