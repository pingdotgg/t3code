// A shared app-server that keeps turns running until the test terminates it.
import * as NodeFS from "node:fs";
import * as NodeReadline from "node:readline";

const fixture = JSON.parse(
  NodeFS.readFileSync(new URL("./codexMultiAgentWire.json", import.meta.url), "utf8"),
);
let nextThreadId = 0;
let nextTurnId = 0;
const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

NodeReadline.createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method, params } = JSON.parse(line);
  switch (method) {
    case "initialize":
      write({
        id,
        result: {
          userAgent: "codex-session-recovery-mock",
          codexHome: process.cwd(),
          platformFamily: "unix",
          platformOs: "linux",
        },
      });
      break;
    case "thread/start": {
      const thread = {
        ...fixture.responses.threadStart.thread,
        id: `thread-${process.pid}-${nextThreadId++}`,
      };
      write({ id, result: { ...fixture.responses.threadStart, thread } });
      break;
    }
    case "thread/resume": {
      const thread = {
        ...fixture.responses.threadStart.thread,
        id: params.threadId,
      };
      write({ id, result: { ...fixture.responses.threadStart, thread } });
      break;
    }
    case "turn/start": {
      const turn = {
        ...fixture.responses.turnStart.turn,
        id: `turn-${process.pid}-${nextTurnId++}`,
      };
      write({ id, result: { turn } });
      write({ method: "turn/started", params: { threadId: params.threadId, turn } });
      break;
    }
    case "test/exit":
      process.exit(7);
      break;
    default:
      if (id !== undefined) write({ id, result: {} });
  }
});
