#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";

const cwdLogPath = process.env.T3_CODEX_CWD_LOG_PATH;
const exitLogPath = process.env.T3_CODEX_EXIT_LOG_PATH;
const hangSkillsList = process.env.T3_CODEX_HANG_SKILLS_LIST === "1";

function appendLog(path: string | undefined, line: string): void {
  if (path) NodeFS.appendFileSync(path, `${line}\n`, "utf8");
}

function respond(id: number | string, result: unknown): void {
  process.stdout.write(`${JSON.stringify({ id, result })}\n`);
}

process.once("SIGTERM", () => {
  appendLog(exitLogPath, "SIGTERM");
  process.exit(0);
});
process.once("exit", (code) => appendLog(exitLogPath, `exit:${code}`));

let remainder = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  remainder += chunk;
  const lines = remainder.split("\n");
  remainder = lines.pop() ?? "";

  for (const line of lines) {
    if (!line.trim()) continue;
    const message = JSON.parse(line) as Record<string, unknown>;
    const id = message.id;
    if ((typeof id !== "number" && typeof id !== "string") || typeof message.method !== "string") {
      continue;
    }

    switch (message.method) {
      case "initialize":
        appendLog(cwdLogPath, process.cwd());
        respond(id, {
          userAgent: "t3code-codex-skills-test",
          codexHome: process.cwd(),
          platformFamily: "unix",
          platformOs: "linux",
        });
        break;
      case "account/read":
        respond(id, {
          account: { type: "chatgpt", email: "test@example.com", planType: "plus" },
          requiresOpenaiAuth: false,
        });
        break;
      case "skills/list":
        if (!hangSkillsList) {
          respond(id, {
            data: [
              {
                cwd: process.cwd(),
                errors: [],
                skills: [
                  {
                    name: "workspace-skill",
                    description: "A workspace-scoped test skill.",
                    shortDescription: "Workspace test skill",
                    path: `${process.cwd()}/.agents/skills/workspace-skill/SKILL.md`,
                    scope: "repo",
                    enabled: true,
                  },
                ],
              },
            ],
          });
        }
        break;
      default:
        respond(id, {});
    }
  }
});
process.stdin.on("end", () => process.exit(0));
