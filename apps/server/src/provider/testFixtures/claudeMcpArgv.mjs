import * as NodeReadline from "node:readline";

// Inert SDK protocol peer. Tests supply only synthetic credentials.
process.send?.({
  type: "spawn",
  args: process.argv.slice(2),
  authorization: process.env.T3_MCP_AUTHORIZATION ?? null,
});

let prompts = 0;
const input = NodeReadline.createInterface({ input: process.stdin });
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.type === "user") {
    prompts += 1;
    return;
  }
  if (message.type !== "control_request") return;
  process.stdout.write(
    JSON.stringify({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: message.request_id,
        response:
          message.request.subtype === "initialize"
            ? { commands: [], models: [], agents: [], account: {}, output_style: "default" }
            : {},
      },
    }) + "\n",
  );
});
process.on("message", (message) => {
  if (message === "inspect") process.send?.({ type: "state", prompts });
});
input.on("close", () => process.exit(0));
