// Drives raw IPC from a configured child; flood pauses reads until SIGUSR2 and burst reads every answer.
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";

const config = JSON.parse(NodeFS.readFileSync("raw-child.json", "utf8"));
NodeFS.writeFileSync("raw-child.pid", String(process.pid));
const channel = new NodeNet.Socket({ fd: 3, readable: true, writable: true });
const send = (message) => channel.write(`${JSON.stringify(message)}\n`);
const log = (message) => send({ _tag: "Log", level: "info", message });

let answered = 0;
const failures = [];
const hostCalls = () => {
  for (let requestId = 1; requestId <= config.requests; requestId++)
    send({ _tag: "HostCall", requestId, method: config.method, input: {} });
};

const receive = (message) => {
  switch (message._tag) {
    case "Activate":
      send({ _tag: "Ready" });
      if (config.mode === "echo") return;
      hostCalls();
      if (config.mode === "flood") channel.pause();
      return;
    case "Invoke":
      send({ _tag: "Succeeded", requestId: message.requestId, value: message.input });
      return;
    case "Deactivate":
      process.exit(0);
      return;
    case "HostCallSucceeded":
    case "HostCallFailed":
      answered++;
      if (message._tag === "HostCallFailed") {
        failures.push(message.message);
        log(`refused: ${message.message}`);
      }
      if (answered === config.requests)
        log(
          `answered ${answered}, refused ${failures.length}: ${JSON.stringify([...new Set(failures)])}`,
        );
      return;
  }
};

process.on("SIGUSR2", () => channel.resume());
// A paused socket does not keep the process alive; the server ends it with Deactivate or a kill.
setInterval(() => {}, 1 << 30);
let buffered = "";
channel.on("data", (chunk) => {
  buffered += chunk.toString("utf8");
  let newline;
  while ((newline = buffered.indexOf("\n")) !== -1) {
    const line = buffered.slice(0, newline);
    buffered = buffered.slice(newline + 1);
    receive(JSON.parse(line));
  }
});
channel.on("end", () => process.exit(0));
channel.on("error", () => process.exit(1));
