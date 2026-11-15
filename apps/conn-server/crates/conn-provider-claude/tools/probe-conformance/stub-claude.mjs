#!/usr/bin/env node
// A stand-in `claude` for the status probe conformance check. No model is called.
//
// It reads its behaviour from `behaviour.json` beside it (resolved through symlinks) and
// records each run to `records/<n>.json`: argv, environment, working folder, every stdin
// line, and the signals it got.
//
//   --version            prints `version.stdout` and exits with `version.code`; with
//                        `version.hang` it sleeps until a signal ends it.
//   (SDK stream mode)    answers `initialize` with `init` (or an error when `init` is
//                        "error"), `get_usage` with `usage` (or an error), `get_settings`
//                        with `settings` (or an error), and exits when stdin ends.
import * as fs from "node:fs";
import * as path from "node:path";
import { createInterface } from "node:readline";

const here = path.dirname(fs.realpathSync(process.argv[1]));
const behaviour = JSON.parse(fs.readFileSync(path.join(here, "behaviour.json"), "utf8"));
const records = path.join(here, "records");
fs.mkdirSync(records, { recursive: true });
const index = fs.readdirSync(records).filter((f) => f.endsWith(".json")).length;
const recordPath = path.join(records, `${String(index).padStart(3, "0")}.json`);
const argv = process.argv.slice(2);
const record = { argv, env: { ...process.env }, cwd: process.cwd(), stdin: [], signals: [] };
// Written aside, then renamed: a run killed mid-write keeps its last whole record.
const save = () => {
  fs.writeFileSync(`${recordPath}.tmp`, `${JSON.stringify(record, null, 1)}\n`);
  fs.renameSync(`${recordPath}.tmp`, recordPath);
};
save();

for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(signal, () => {
    record.signals.push(signal);
    save();
    process.exit(128 + (signal === "SIGTERM" ? 15 : signal === "SIGINT" ? 2 : 1));
  });
}

if (argv.includes("-p")) {
  // A text generation run: the prompt on stdin, one JSON answer on stdout. `title` lists the
  // answers of the runs in order.
  let prompt = "";
  process.stdin.on("data", (chunk) => (prompt += chunk));
  process.stdin.on("end", () => {
    record.stdin.push(prompt);
    const runs = (behaviour.title ?? []);
    const answer = runs[Math.min(index, runs.length - 1)] ?? { code: 1, stderr: "no answer" };
    save();
    if (answer.stdout) process.stdout.write(answer.stdout);
    if (answer.stderr) process.stderr.write(answer.stderr);
    process.exitCode = answer.code ?? 0;
  });
} else if (argv.includes("--version")) {
  const version = behaviour.version ?? {};
  if (version.hang === true) {
    setInterval(() => {}, 1000);
  } else {
    if (version.stdout) process.stdout.write(version.stdout);
    if (version.stderr) process.stderr.write(version.stderr);
    save();
    process.exit(version.code ?? 0);
  }
} else {
  const write = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
  const answer = (request, value) => {
    if (value === "error" || value === undefined) {
      write({
        type: "control_response",
        response: { subtype: "error", request_id: request.request_id, error: "not supported by this stub" },
      });
    } else {
      write({ type: "control_response", response: { subtype: "success", request_id: request.request_id, response: value } });
    }
  };
  createInterface({ input: process.stdin }).on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      message = line;
    }
    record.stdin.push(message);
    save();
    if (message?.type !== "control_request") return;
    switch (message.request?.subtype) {
      case "initialize":
        answer(message, behaviour.init);
        break;
      case "get_usage":
        answer(message, behaviour.usage);
        break;
      case "get_settings":
        answer(message, behaviour.settings);
        break;
      default:
        answer(message, {});
    }
  });
  process.stdin.on("end", () => {
    save();
    process.exit(0);
  });
}
