// @effect-diagnostics nodeBuiltinImport:off - Synthetic capture data and local release barriers.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";

import type * as AcpSchema from "effect-acp/schema";

const timelineFixtureEpoch = "2026-01-01T12:00:00.000Z";
const timelineFixturePhases = ["entry", "tool-start", "tool-finish", "prose", "resumed"] as const;

export function timelineFollowFixture(kind: "long" | "short") {
  const say = (text: string): AcpSchema.SessionUpdate => ({
    sessionUpdate: "agent_message_chunk",
    messageId: "timeline-fixture-answer",
    content: { type: "text", text },
  });
  const paragraph = (index: number) =>
    `Paragraph ${String(index).padStart(3, "0")}. The amber lighthouse overlooks a quiet harbor. ` +
    "A keeper records the tide, checks the lantern, and leaves a clear note for the next watch. " +
    "This fixed paragraph marks a stable reading position while new output arrives.\n\n";
  const tool = (status: "in_progress" | "completed"): AcpSchema.SessionUpdate => ({
    sessionUpdate: "tool_call_update",
    toolCallId: "timeline-fixture-tool",
    title: "Check the harbor log",
    kind: "execute",
    status,
    rawInput: { command: "printf 'harbor clear\\n'" },
    ...(status === "completed"
      ? { rawOutput: { stdout: "harbor clear\n", stderr: "", exitCode: 0 } }
      : {}),
  });
  return [
    {
      phase: "entry",
      updates:
        kind === "long"
          ? [say(Array.from({ length: 100 }, (_, i) => paragraph(i + 1)).join(""))]
          : [say("The harbor is quiet.\n\n")],
    },
    { phase: "tool-start", updates: [tool("in_progress")] },
    { phase: "tool-finish", updates: [tool("completed")] },
    {
      phase: "prose",
      updates:
        kind === "long"
          ? [say(Array.from({ length: 20 }, (_, i) => paragraph(i + 101)).join(""))]
          : [say("The lantern is ready.\n\n")],
    },
    {
      phase: "resumed",
      updates: [say(kind === "long" ? paragraph(121) + paragraph(122) : "All clear.")],
    },
  ];
}

// The driver creates a release file only after capturing the previous checkpoint.
// Watching the directory before checking the file avoids a lost release race.
export function waitForTimelineFixtureRelease(directory: string, phase: string) {
  NodeFS.mkdirSync(directory, { recursive: true });
  const releasePath = NodePath.join(directory, `${phase}.release`);
  return new Promise<void>((resolve, reject) => {
    const watcher = NodeFS.watch(directory, () => {
      if (!NodeFS.existsSync(releasePath)) return;
      watcher.close();
      resolve();
    });
    watcher.on("error", (error) => {
      watcher.close();
      reject(error);
    });
    if (NodeFS.existsSync(releasePath)) {
      watcher.close();
      resolve();
    }
  });
}

if (process.argv[1] && import.meta.url === NodeURL.pathToFileURL(process.argv[1]).href) {
  const [command, directory, phase, provider, kind] = process.argv.slice(2);
  if (command === "print") {
    process.stdout.write(
      JSON.stringify(
        {
          epoch: timelineFixtureEpoch,
          long: timelineFollowFixture("long"),
          short: timelineFollowFixture("short"),
        },
        null,
        2,
      ) + "\n",
    );
  } else if (
    command === "release" &&
    directory &&
    timelineFixturePhases.some((value) => value === phase)
  ) {
    NodeFS.mkdirSync(directory, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(directory, `${phase}.release`), "release\n");
  } else if (command === "provider" && directory) {
    process.stdout.write(
      JSON.stringify(
        {
          operation: "create",
          instanceId: "timeline_fixture",
          instance: {
            driver: "acpRegistry",
            displayName: "Timeline fixture",
            enabled: true,
            config: {
              source: "local",
              commandPath: process.execPath,
              commandArgs: [NodePath.join(import.meta.dirname, "acp-mock-agent.ts")],
            },
            environment: [
              {
                name: "T3_ACP_TIMELINE_FIXTURE_DIRECTORY",
                value: NodePath.resolve(directory),
                sensitive: false,
              },
            ],
          },
        },
        null,
        2,
      ) + "\n",
    );
  } else if (
    command === "seed" &&
    directory &&
    phase &&
    provider &&
    (kind === "long" || kind === "short")
  ) {
    // Launch through the installed app service; do not write projections or credentials.
    const result = NodeChildProcess.spawnSync(
      process.execPath,
      [
        NodePath.join(import.meta.dirname, "../src/bin.ts"),
        "thread",
        "start",
        "--base-dir",
        NodePath.resolve(directory),
        phase,
        `timeline-fixture:${kind}`,
        "--provider",
        provider,
        "--model",
        "default",
        "--title",
        `Timeline fixture ${kind}`,
        "--json",
      ],
      { encoding: "utf8" },
    );
    process.stdout.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    process.exitCode = result.status ?? 1;
  } else {
    process.stderr.write(
      "Usage: node apps/server/scripts/timeline-follow-fixture.ts\n  print\n  provider <fresh-barrier-root>\n  seed <isolated-home> <project-id-or-path> <provider-instance> <long|short>\n  release <barrier-root/pid-prompt> <entry|tool-start|tool-finish|prose|resumed>\nConfigure the provider JSON through Settings in the isolated environment. Each seed prints actual app thread/run IDs. waiting.json names the next phase; <phase>.done marks delivery. Capture before releasing the next phase. Use a fresh root for each capture run.\n",
    );
    process.exitCode = 2;
  }
}
