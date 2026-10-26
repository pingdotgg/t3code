// @effect-diagnostics nodeBuiltinImport:off - Runs the Claude Code CLI as a reviewer.

import * as NodeProcess from "node:process";

import { run } from "./device.ts";
import type { Finding, PoseResult } from "./report.ts";

const SCHEMA = {
  type: "object",
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          step: { type: "string" },
          issue: { type: "string" },
          severity: { type: "string", enum: ["high", "medium", "low"] },
        },
        required: ["step", "issue", "severity"],
      },
    },
  },
  required: ["findings"],
};

/**
 * Asks an agent to look at one pose's screenshots for what the generic checks cannot see:
 * clipped or overlapping text, wrong colours for the appearance, odd gaps, unreadable
 * contrast. It reads the images itself and returns structured findings.
 */
export async function reviewPose(result: PoseResult, outputDirectory: string): Promise<Finding[]> {
  const shots = result.steps.filter((step) => step.screenshot);
  if (shots.length === 0) return [];
  const { pose } = result;
  const prompt = [
    `You are reviewing screenshots of the T3 Code mobile app (a client for coding agents) for visual bugs.`,
    `Device: ${pose.device} (${pose.platform}, ${pose.form}), ${pose.appearance} appearance${pose.landscape ? ", landscape" : ""}${pose.fold ? `, fold ${pose.fold}` : ""}${pose.textSize ? ", largest accessibility text size" : ""}.`,
    `Read each screenshot below with the Read tool. Each is one step of the same session:`,
    ...shots.map((step) => `- step "${step.name}": ${step.screenshot}`),
    ``,
    `Report only real defects a user would notice: text clipped, truncated mid-word where it should wrap, or overlapping other content; controls overlapping, cut off, or under the status bar, notch, home indicator, or keyboard; content hidden behind navigation chrome; colours wrong for the ${pose.appearance} appearance or unreadable contrast; large unexplained empty areas or misaligned layout; error banners or red error screens.`,
    `Ignore: the fixture content itself, the status bar clock, a development-build badge, and anything that is plainly a deliberate design choice. Prefer no finding to a speculative one.`,
    `Use the exact step names above. Severity: high = broken or unusable, medium = clearly wrong, low = polish.`,
  ].join("\n");
  const { stdout } = await run(
    "claude",
    [
      "-p",
      prompt,
      "--output-format",
      "json",
      "--json-schema",
      JSON.stringify(SCHEMA),
      "--allowedTools",
      "Read",
      "--add-dir",
      outputDirectory,
      "--no-session-persistence",
      ...(NodeProcess.env.T3_E2E_REVIEW_MODEL
        ? ["--model", NodeProcess.env.T3_E2E_REVIEW_MODEL]
        : []),
    ],
    { cwd: outputDirectory, timeoutMs: 600_000 },
  );
  const output = JSON.parse(stdout) as { structured_output?: { findings?: Finding[] } };
  return output.structured_output?.findings ?? [];
}
