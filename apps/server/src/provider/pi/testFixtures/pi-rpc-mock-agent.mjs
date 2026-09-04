import * as NodeStringDecoder from "node:string_decoder";

const decoder = new NodeStringDecoder.StringDecoder("utf8");
let buffer = "";

function send(message, callback) {
  process.stdout.write(`${JSON.stringify(message)}\n`, callback);
}

function handle(command) {
  if (command.type === "get_state") {
    send({ type: "queue_update", steering: [], followUp: [] });
    send({
      id: command.id,
      type: "response",
      command: command.type,
      success: true,
      data: {
        model: { provider: "mock", id: "model-1" },
        thinkingLevel: "medium",
        isStreaming: false,
        isCompacting: false,
        steeringMode: "one-at-a-time",
        followUpMode: "one-at-a-time",
        sessionFile: "/tmp/pi/mock-session.jsonl",
        sessionId: "mock-session",
        autoCompactionEnabled: true,
        messageCount: 0,
        pendingMessageCount: 0,
      },
    });
    return;
  }

  if (command.type === "prompt") {
    if (command.message === "exit") {
      send({ id: command.id, type: "response", command: "prompt", success: true }, () => {
        process.exit(19);
      });
      return;
    }
    send({ id: command.id, type: "response", command: "prompt", success: true });
    send({ type: "agent_start" });
    send({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hello" },
    });
    send({
      type: "extension_ui_request",
      id: "dialog-1",
      method: "confirm",
      title: "Continue?",
      message: "Finish the turn?",
    });
    return;
  }

  if (command.type === "extension_ui_response") {
    send({ type: "agent_end", messages: [], willRetry: false });
    send({ type: "agent_settled" });
    return;
  }

  if (command.type === "abort") {
    send({ id: command.id, type: "response", command: "abort", success: true });
    return;
  }

  send({
    id: command.id,
    type: "response",
    command: command.type,
    success: false,
    error: `Unsupported command: ${command.type}`,
  });
}

process.stdin.on("data", (chunk) => {
  buffer += decoder.write(chunk);
  while (true) {
    const newlineIndex = buffer.indexOf("\n");
    if (newlineIndex < 0) break;
    let line = buffer.slice(0, newlineIndex);
    buffer = buffer.slice(newlineIndex + 1);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (line.length > 0) handle(JSON.parse(line));
  }
});

process.stdin.on("end", () => {
  buffer += decoder.end();
});
