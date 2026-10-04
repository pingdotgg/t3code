import * as NodeFS from "node:fs";

const argv = process.argv.slice(2);
const args = argv.join(" ");

function fail(message, code) {
  process.stderr.write(message + "\n");
  process.exit(code);
}

const permissionIndex = argv.indexOf("--permission-mode");
if (permissionIndex === -1 || argv[permissionIndex + 1] !== "dontAsk") {
  fail("text generation must deny permission prompts", 12);
}
const toolsIndex = argv.indexOf("--tools");
if (toolsIndex === -1 || argv[toolsIndex + 1] !== "") {
  fail("text generation must receive an explicit empty tool set", 6);
}
if (argv.includes("--dangerously-skip-permissions")) {
  fail("text generation must not bypass permissions", 7);
}
if (!argv.includes("--disable-slash-commands")) {
  fail("text generation must disable skills", 8);
}
if (!argv.includes("--strict-mcp-config")) {
  fail("text generation must not load configured MCP servers", 9);
}
const settingsIndex = argv.indexOf("--settings");
if (settingsIndex === -1 || JSON.parse(argv[settingsIndex + 1]).disableAllHooks !== true) {
  fail("text generation must disable hooks", 10);
}
const cwdMustNotBe = process.env.T3_FAKE_CLAUDE_CWD_MUST_NOT_BE;
if (cwdMustNotBe && NodeFS.realpathSync(process.cwd()) === NodeFS.realpathSync(cwdMustNotBe)) {
  fail("text generation ran in the project directory", 11);
}

let stdinContent = "";
if (!process.stdin.isTTY) {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  stdinContent = Buffer.concat(chunks).toString("utf8");
}

const argsMustContain = process.env.T3_FAKE_CLAUDE_ARGS_MUST_CONTAIN;
if (argsMustContain && !args.includes(argsMustContain)) {
  fail("args missing expected content", 2);
}

const argsMustNotContain = process.env.T3_FAKE_CLAUDE_ARGS_MUST_NOT_CONTAIN;
if (argsMustNotContain && args.includes(argsMustNotContain)) {
  fail("args contained forbidden content", 3);
}

const stdinMustContain = process.env.T3_FAKE_CLAUDE_STDIN_MUST_CONTAIN;
if (stdinMustContain && !stdinContent.includes(stdinMustContain)) {
  fail("stdin missing expected content", 4);
}

const configDirMustBe = process.env.T3_FAKE_CLAUDE_CONFIG_DIR_MUST_BE;
if (configDirMustBe && process.env.CLAUDE_CONFIG_DIR !== configDirMustBe) {
  fail("CLAUDE_CONFIG_DIR was " + (process.env.CLAUDE_CONFIG_DIR ?? ""), 5);
}

const stderrText = process.env.T3_FAKE_CLAUDE_STDERR;
if (stderrText) {
  process.stderr.write(stderrText + "\n");
}

process.stdout.write(process.env.T3_FAKE_CLAUDE_OUTPUT ?? "");
process.exitCode = Number(process.env.T3_FAKE_CLAUDE_EXIT_CODE ?? 0);
