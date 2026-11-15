#!/usr/bin/env node
// A stand-in `codex` for the status probe conformance check. No model is called, and nothing
// is read from or sent to OpenAI.
//
// It reads its behaviour from `behaviour.json` beside it (resolved through symlinks) and
// records each run to `records/<n>.json`: argv, environment, working folder, every stdin
// line, and how it ended (`EOF` when stdin closed, then the signals it got).
//
//   --version       prints `version.stdout` and exits with `version.code`; `version.hang`
//                   waits for a signal.
//   app-server      `hang`: reads, never answers. Otherwise
//                   it answers `initialize`, `account/read`, `skills/list`, `model/list`
//                   (one page per call, in order), `config/read` and
//                   `account/rateLimits/read` from the behaviour: a value is the result,
//                   "error" an error, "hang" no answer. `refreshCache` writes
//                   `$CODEX_HOME/models_cache.json` with a fresh `fetched_at` at start.
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
const record = { argv, env: { ...process.env }, cwd: process.cwd(), stdin: [], ended: [] };
const save = () => fs.writeFileSync(recordPath, `${JSON.stringify(record, null, 1)}\n`);
save();

for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(signal, () => {
    record.ended.push(signal);
    save();
    process.exit(128 + (signal === "SIGTERM" ? 15 : signal === "SIGINT" ? 2 : 1));
  });
}

if (argv.includes("--version")) {
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
  const codexHome = process.env.CODEX_HOME || path.join(process.env.HOME ?? "/", ".codex");
  if (behaviour.refreshCache === true) {
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(path.join(codexHome, "models_cache.json"), JSON.stringify({ fetched_at: new Date().toISOString(), models: [] }));
  }
  const write = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
  let modelPage = 0;
  const answerFor = (message) => {
    switch (message.method) {
      case "initialize":
        return behaviour.init ?? {
          userAgent: "codex_cli_rs/0.166.0 (Mac OS 26.1.0; arm64) T3 Code (T3 Code; 0.0.0)",
          codexHome,
          platformFamily: "unix",
          platformOs: "macos",
        };
      case "account/read":
        return behaviour.account;
      case "skills/list": {
        const skills = behaviour.skills;
        if (typeof skills !== "object" || skills === null) return skills;
        const cwd = message.params?.cwds?.[0] ?? "";
        return JSON.parse(JSON.stringify(skills).replaceAll("<cwd>", cwd));
      }
      case "model/list": {
        const pages = behaviour.models;
        if (!Array.isArray(pages)) return pages;
        const page = pages[Math.min(modelPage, pages.length - 1)];
        modelPage = (modelPage + 1) % pages.length;
        return page;
      }
      case "config/read":
        return behaviour.config;
      case "account/rateLimits/read":
        return behaviour.rateLimits;
      default:
        return "error";
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
    if (behaviour.hang === true || typeof message !== "object" || message.id === undefined) return;
    const answer = answerFor(message);
    if (answer === "hang" || answer === undefined) return;
    if (answer === "error") {
      write({ id: message.id, error: { code: -32603, message: `stub refuses ${message.method}` } });
    } else {
      write({ id: message.id, result: answer });
    }
  });
  // A real app-server ends when its input ends. The stub lingers a moment, so a signal that
  // follows the end of input is seen and recorded in a fixed order.
  process.stdin.on("end", () => {
    record.ended.push("EOF");
    save();
    setTimeout(() => process.exit(0), 300);
  });
}
