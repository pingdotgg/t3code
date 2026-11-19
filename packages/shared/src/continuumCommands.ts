/**
 * Continuum's slash commands. An `action` runs in the client instead of a turn; a `skill` is sent
 * as a normal turn whose inline context carries the procedure, so every provider gets the same
 * behavior without its own skill system.
 */

export type ContinuumCommandName =
  | "improve"
  | "swarm"
  | "debug"
  | "review"
  | "optimize"
  | "test"
  | "explain"
  | "forge"
  | "vision"
  | "timemachine"
  | "contweb";

export type ContinuumPanel = "forge" | "agent-eyes" | "time-machine" | "swarm" | "preview";

export interface ContinuumCommandSpec {
  readonly name: ContinuumCommandName;
  readonly kind: "action" | "skill";
  readonly description: string;
  /** Shown after the command in the menu and in errors. */
  readonly argumentHint: string;
  /** False when the command needs text after it. */
  readonly allowsEmpty: boolean;
  /** Opened when the command is sent. A skill sent with no text only opens its panel. */
  readonly panel: ContinuumPanel | null;
  /** Skills only: the procedure the agent follows. */
  readonly procedure: string | null;
}

const SKILL_FOOTER =
  "Report what you actually observed. Quote the command, output, file and line, or screenshot that supports each claim. If something could not be checked, say so instead of guessing.";

export const CONTINUUM_COMMANDS: ReadonlyArray<ContinuumCommandSpec> = [
  {
    name: "improve",
    kind: "action",
    description: "Rewrite this prompt with the thread's context, then open it in a new session",
    argumentHint: "<prompt to improve>",
    allowsEmpty: false,
    panel: null,
    procedure: null,
  },
  {
    name: "debug",
    kind: "skill",
    description: "Find the cause of a failure from logs, source, tests, and runtime tools",
    argumentHint: "<what is failing>",
    allowsEmpty: false,
    panel: null,
    procedure: [
      "Debug the failure the user describes. Work in this order and do not skip ahead to a fix:",
      "1. Reproduce: find the narrowest command, test, or UI action that shows the failure and run it. Capture the exact error output. If a dev server or browser preview is involved, use the preview_* tools (preview_snapshot, preview_evaluate for console errors) to observe it.",
      "2. Localize: read the stack trace and the code it names. Use git log -p / git diff on the files involved to see what changed recently. Form at most three hypotheses and rank them.",
      "3. Confirm: prove or rule out each hypothesis with evidence (a log line, a targeted test, a value printed at runtime). State which one the evidence supports.",
      "4. Fix: make the smallest change that removes the cause, not the symptom. Add or extend a test that fails before the fix and passes after, when the project has tests.",
      "5. Verify: rerun the reproduction from step 1 and the relevant tests. Show the output.",
      "End with: Root cause, Evidence, Fix, Verification, and anything still uncertain.",
    ].join("\n"),
  },
  {
    name: "review",
    kind: "skill",
    description: "Structured code review: correctness, maintainability, security, performance",
    argumentHint: "[files, branch, or what to review]",
    allowsEmpty: true,
    panel: null,
    procedure: [
      "Review code changes. Scope: what the user names; otherwise the uncommitted changes (git status, git diff, git diff --staged), and if there are none, the current branch against its merge base with the default branch.",
      "Read every changed hunk and enough surrounding code to judge it. Do not edit files unless the user asks for fixes.",
      "Check, in this order:",
      "- Correctness: logic errors, unhandled cases, broken invariants, race conditions, wrong error handling, behavior that contradicts the code's own tests or docs.",
      "- Security: injection, path traversal, unsafe deserialization, secrets in code or logs, missing authorization checks, unsafe defaults.",
      "- Performance: work repeated in loops or renders, unbounded growth, blocking I/O on hot paths, excessive network payloads.",
      "- Maintainability: duplication, names that mislead, dead code, missing tests for behavior that can break.",
      "Run the project's existing type check, linter, or tests for the changed files when they are cheap to run, and report the results.",
      "Output findings grouped by severity (must fix, should fix, nit). For each: file:line, the problem, a concrete failure scenario, and a suggested fix. Say plainly if you found nothing that must be fixed.",
    ].join("\n"),
  },
  {
    name: "optimize",
    kind: "skill",
    description: "Measure a performance bottleneck and propose or apply measurable improvements",
    argumentHint: "<what is slow>",
    allowsEmpty: false,
    panel: null,
    procedure: [
      "Optimize the performance problem the user names. Measure before changing anything:",
      "1. Establish a baseline: pick a repeatable measurement (a benchmark, a timed command, a profiler run, bundle size, render count, query plan) and run it at least three times. Record the numbers.",
      "2. Profile to find where the time or memory actually goes. Do not optimize code the profile does not implicate.",
      "3. Propose changes ranked by expected gain versus risk. Apply the best one or two unless the user asked only for a proposal.",
      "4. Re-measure with the same method and report before/after numbers with the variance you saw. Run the relevant tests to show behavior did not change.",
      "If a change does not produce a measurable gain, revert it and say so.",
    ].join("\n"),
  },
  {
    name: "test",
    kind: "skill",
    description: "Write and run tests for a feature or component",
    argumentHint: "<feature, file, or component>",
    allowsEmpty: false,
    panel: null,
    procedure: [
      "Write tests for what the user names, then run them.",
      "1. Find the project's existing test framework, conventions, and nearby tests. Extend an existing test file or table when one covers this area; add a new file only when none fits.",
      "2. List the behaviors that can break: normal cases, edge cases, error paths, and any bug the user mentioned. Skip tests for what the type system already guarantees.",
      "3. Write focused tests at the lowest layer that exercises each behavior. No sleeps or timing-based waits; await the real event or result.",
      "4. Run the new tests and show the output. If one fails, decide whether the test or the code is wrong, explain which, and fix the right one.",
      "Report the tests added, what each covers, and the final run output.",
    ].join("\n"),
  },
  {
    name: "explain",
    kind: "skill",
    description: "Explain code, architecture, an error, or how something runs",
    argumentHint: "<code, file, error, or question>",
    allowsEmpty: false,
    panel: null,
    procedure: [
      "Explain what the user asks about, grounded in this codebase. Read the code involved first; do not explain from general knowledge alone.",
      "Start with a two or three sentence answer. Then walk through the relevant path with file:line references: entry point, the main steps, where data or control goes, and any non-obvious constraint.",
      "For an error, explain what produced it, why, and what would make it go away. For architecture, name the components and how they connect.",
      "Do not change files. Keep it as short as the question allows.",
    ].join("\n"),
  },
  {
    name: "forge",
    kind: "skill",
    description: "Open Forge, or create and edit game assets and engine projects",
    argumentHint: "[asset or game task]",
    allowsEmpty: true,
    panel: "forge",
    procedure: [
      "Use Continuum Forge for this game-development or asset task.",
      "- Start with continuum_game_status to see connected editors (Godot, Roblox Studio, Unity, Unreal), the project, and available operations. Use only operations the connected editor advertises.",
      "- Before changing a scene, script, or project files, save a checkpoint with continuum_game_checkpoint.",
      "- Change the engine through continuum_game_call (scene.tree, object.create, object.update, script.write, asset.import, ...). Never edit binary scene files by hand while an editor has them open.",
      "- For 3D assets, use continuum_asset_blender: build in Blender, keep the .blend source, export a game format (glTF/GLB or FBX), render a preview, and save it with continuum_asset_save_revision so its checks run. For 2D art, write editable sources (SVG, Aseprite-compatible PNG sprite sheets with a JSON frame map, Tiled .tmj maps, or Godot .tres resources) rather than flattened images.",
      "- Show the preview to the user before importing a new or replaced asset with continuum_asset_import.",
      "- Verify: compile (build.compile), run tests (continuum_game_run_tests), playtest, read continuum_game_logs, and capture the viewport (continuum_game_capture). Report what the capture and logs show.",
    ].join("\n"),
  },
];

function continuumCommandSpec(name: string): ContinuumCommandSpec | null {
  return CONTINUUM_COMMANDS.find((command) => command.name === name.toLowerCase()) ?? null;
}

export interface ParsedContinuumCommand {
  readonly spec: ContinuumCommandSpec;
  /** The text after the command, trimmed. */
  readonly args: string;
}

/** A Continuum command at the start of a message, such as `/review src/auth`. */
export function parseContinuumCommand(
  text: string,
  available: ReadonlySet<ContinuumCommandName> | null = null,
): ParsedContinuumCommand | null {
  const match = /^\/([a-z]+)(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (!match) return null;
  const spec = continuumCommandSpec(match[1] ?? "");
  if (spec === null) return null;
  if (available !== null && !available.has(spec.name)) return null;
  return { spec, args: match[2]?.trim() ?? "" };
}

/**
 * The inline context for a skill turn: the procedure plus the user's request. Null when the
 * message is not a Continuum skill. The user's message itself is sent unchanged.
 */
export function continuumSkillContext(userText: string): string | null {
  const parsed = parseContinuumCommand(userText);
  if (parsed === null || parsed.spec.kind !== "skill" || parsed.spec.procedure === null) {
    return null;
  }
  return [
    `<continuum_skill name="${parsed.spec.name}">`,
    `The user ran Continuum IDE's /${parsed.spec.name} command. Follow this procedure for their request.`,
    "",
    parsed.spec.procedure,
    "",
    SKILL_FOOTER,
    "</continuum_skill>",
  ].join("\n");
}
