import React, { useState } from "react";
import { Box, Text } from "ink";
import TextInput from "ink-text-input";
import type { Message } from "../../types.ts";
import { MarkdownText } from "./MarkdownText.tsx";

interface Props {
  messages: Message[];
  isExecuting: boolean;
  onSubmit: (input: string) => void;
}

export const ChatView: React.FC<Props> = ({
  messages,
  isExecuting,
  onSubmit,
}) => {
  const [input, setInput] = useState("");

  const handleSubmit = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed || isExecuting) return;
    onSubmit(trimmed);
    setInput("");
  };

  return (
    <Box flexDirection="column">
      {messages.length > 0 && (
        <Box flexDirection="column" marginBottom={1}>
          {messages.map((msg, i) => (
            <MessageBubble key={i} message={msg} />
          ))}
        </Box>
      )}

      <Box>
        <Text color="cyan">{isExecuting ? "  " : "> "}</Text>
        {isExecuting ? (
          <Text dimColor>Claude is thinking...</Text>
        ) : (
          <TextInput
            value={input}
            onChange={setInput}
            onSubmit={handleSubmit}
            placeholder="What would you like to do?"
          />
        )}
      </Box>

      <Box marginTop={1}>
        <Text dimColor>Ctrl+C to exit</Text>
        {messages.length > 0 && (
          <Text dimColor>  •  Ctrl+R to reset session</Text>
        )}
      </Box>
    </Box>
  );
};

const MessageBubble: React.FC<{ message: Message }> = ({ message }) => {
  const isUser = message.role === "user";

  return (
    <Box flexDirection="column" marginY={1}>
      <Text bold color={isUser ? "blue" : "green"}>
        {isUser ? "You" : "Claude"}
      </Text>
      {isUser ? (
        <Text wrap="wrap">{message.content}</Text>
      ) : (
        <MarkdownText>{message.content}</MarkdownText>
      )}

      {message.toolUse && message.toolUse.length > 0 && (
        <Box marginTop={1}>
          <Text dimColor>
            {"  ran "}
            {message.toolUse.map((t) => toolSummary(t.name, t.input)).join("  ·  ")}
          </Text>
        </Box>
      )}
    </Box>
  );
};

function toolSummary(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case "read_file":
      return `read ${input["path"]}`;
    case "write_file":
      return `write ${input["path"]}`;
    case "list_directory":
      return `ls ${input["path"] ?? "."}`;
    default: {
      const json = JSON.stringify(input);
      const preview = json.slice(0, 60);
      return `${name}(${preview}${json.length > 60 ? "..." : ""})`;
    }
  }
}
