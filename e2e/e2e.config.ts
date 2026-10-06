import type { E2EConfig } from "e2e";
import { web } from "@e2e-dev/web";
import { gateway } from "ai";

import { FIXTURE_PROJECT_NAME } from "./support/instance.ts";

const context =
  "T3 Code is a GUI for coding agents. A project is a local folder, a thread is one conversation with an agent inside a project. " +
  `This is an isolated test server with one project, "${FIXTURE_PROJECT_NAME}" (a small git repository), and its bootstrap thread "New thread". ` +
  "Every provider (Codex, Claude, Grok, OpenCode, Pi, Antigravity) is a scripted fake; Cursor is disabled. A message containing `write <file>` runs a shell command that writes that file, asking for approval first in Supervised mode; a message containing `wait` keeps the turn running until Stop; any other message gets the reply `Fake <Provider> received: <message>`. Antigravity needs Sign in under Settings > Providers before it lists models. " +
  "Some controls act on the host machine, never use them: Update or install a provider, Open in an editor, Publish repository or push, sign in to a provider, connect T3 Connect, pair another device, open external links. " +
  "Not bugs: a link that opens a new tab leaves this one unchanged; accessible text splits around inline links, so judge copy by the rendered screen.";

const model = gateway("openai/gpt-6-luna-fast");
const persona = { model, context, maxSteps: 40, maxModelCalls: 40 };

export default {
  // Fake Codex turns finish in well under a second, but loaded CI hosts need headroom.
  assertionTimeout: 20_000,
  // CI defaults to read-only; it restores and saves `.e2e/cache` through the GitHub
  // Actions cache, so passing agent steps keep replaying there too.
  cache: "read-write",
  targets: [
    {
      name: "web",
      engine: web(),
      app: {
        url: "http://127.0.0.1:0",
        command: {
          executable: "node",
          args: ["scripts/start-app.ts", "{port}"],
          startupTimeout: 120_000,
          log: ".e2e/logs/app.log",
        },
      },
    },
  ],
  agents: {
    default: { ...persona, system: "You are a thorough QA agent. Verify every outcome on screen." },
    skeptic: {
      ...persona,
      system:
        "Distrust every number, date, count, label, and status on screen; cross-check each against every other place it appears.",
    },
    fuzzer: {
      ...persona,
      system:
        "At every input, run the goal's input matrix before anything else, judging each entry before the next. Never take the happy path.",
    },
  },
} satisfies E2EConfig;
