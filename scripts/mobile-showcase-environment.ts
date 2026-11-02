// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off - This host-side fixture creates an isolated local T3 environment.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeUtil from "node:util";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);

const SHOWCASE_PROJECT_ID = "t3code";
const SHOWCASE_THREAD_ID = "remote-command-center";

export const SHOWCASE_SCENES = [
  "threads",
  "thread",
  "terminal",
  "review",
  "environments",
  "agent-activity",
] as const;
export type ShowcaseScene = (typeof SHOWCASE_SCENES)[number];

const MODEL_SELECTION = JSON.stringify({ instanceId: "codex", model: "gpt-5.4" });
const PROJECT_SCRIPTS = JSON.stringify([
  {
    id: "dev",
    name: "Dev",
    command: "pnpm dev",
    icon: "play",
    runOnWorktreeCreate: false,
  },
  {
    id: "test",
    name: "Tests",
    command: "pnpm test",
    icon: "test",
    runOnWorktreeCreate: false,
  },
]);

const SHOWCASE_TERMINAL_PROMPT =
  "\u001b[1;32m→\u001b[0m \u001b[1;36mt3code\u001b[0m \u001b[1;34mgit:(\u001b[1;31mfeat/remote-command-center\u001b[1;34m)\u001b[0m \u001b[1;33m✗\u001b[0m ";

const SHOWCASE_TERMINAL_BUFFER = [
  `${SHOWCASE_TERMINAL_PROMPT}vpr dev`,
  "",
  "  \u001b[1;32mVITE\u001b[0m \u001b[32mv7.1.1\u001b[0m  \u001b[2mready in\u001b[0m \u001b[1m1.24s\u001b[0m",
  "",
  "  \u001b[32m→\u001b[0m  \u001b[2mLocal:\u001b[0m    \u001b[4;36mhttp://127.0.0.1:5173/\u001b[0m",
  "  \u001b[32m→\u001b[0m  \u001b[2mNetwork:\u001b[0m  \u001b[4;36mhttp://192.168.1.24:5173/\u001b[0m",
  "  \u001b[32m→\u001b[0m  \u001b[2mProject:\u001b[0m  \u001b[1mt3code\u001b[0m \u001b[2m(~/Code/t3code)\u001b[0m",
  "",
  "  \u001b[32m✓ 612 passed\u001b[0m   \u001b[33m△ 2 warnings\u001b[0m   \u001b[31m✗ 0 failed\u001b[0m",
  "",
  "  \u001b[42;30m READY \u001b[0m \u001b[2mwatching for changes, press\u001b[0m \u001b[1mq\u001b[0m \u001b[2mto quit\u001b[0m",
  "",
  SHOWCASE_TERMINAL_PROMPT,
].join("\r\n");

const BASE_ENVIRONMENT_PRESENCE = `export function environmentLabel(count: number): string {
  return \`${"${count}"} environments\`;
}
`;

const UPDATED_ENVIRONMENT_PRESENCE = `const PULSE = ["✦", "✧", "·", "✧"] as const;

export function environmentLabel(connected: number, total: number, frame: number): string {
  const pulse = PULSE[frame % PULSE.length];
  return \`${"${pulse} ${connected}/${total}"} ready\`;
}
`;

const REMOTE_HANDOFF_CARD = `import { View, Text } from "react-native";

export function RemoteHandoffCard(props: { machine: string; latencyMs: number }) {
  return (
    <View className="rounded-2xl bg-surface-2 p-4">
      <Text className="font-semibold">Ready on {props.machine}</Text>
      <Text className="text-success">Handoff in {props.latencyMs}ms</Text>
    </View>
  );
}
`;

const PROJECT_FAVICONS = {
  t3code: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
  <rect width="128" height="128" rx="10" fill="#000"/>
  <path d="M33.4509 93V47.56H15.5309V37H64.3309V47.56H46.4109V93H33.4509ZM86.7253 93.96C82.832 93.96 78.9653 93.4533 75.1253 92.44C71.2853 91.3733 68.032 89.88 65.3653 87.96L70.4053 78.04C72.5386 79.5867 75.0186 80.8133 77.8453 81.72C80.672 82.6267 83.5253 83.08 86.4053 83.08C89.6586 83.08 92.2186 82.44 94.0853 81.16C95.952 79.88 96.8853 78.12 96.8853 75.88C96.8853 73.7467 96.0586 72.0667 94.4053 70.84C92.752 69.6133 90.0853 69 86.4053 69H80.4853V60.44L96.0853 42.76L97.5253 47.4H68.1653V37H107.365V45.4L91.8453 63.08L85.2853 59.32H89.0453C95.9253 59.32 101.125 60.8667 104.645 63.96C108.165 67.0533 109.925 71.0267 109.925 75.88C109.925 79.0267 109.099 81.9867 107.445 84.76C105.792 87.48 103.259 89.6933 99.8453 91.4C96.432 93.1067 92.0586 93.96 86.7253 93.96Z" fill="#fff"/>
</svg>`,
  react: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="15" fill="#20232a"/>
  <g fill="none" stroke="#61dafb" stroke-width="2.8"><ellipse cx="32" cy="32" rx="25" ry="9"/><ellipse cx="32" cy="32" rx="25" ry="9" transform="rotate(60 32 32)"/><ellipse cx="32" cy="32" rx="25" ry="9" transform="rotate(120 32 32)"/></g>
  <circle cx="32" cy="32" r="4.8" fill="#61dafb"/>
</svg>`,
  linux: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="15" fill="#f7c948"/>
  <ellipse cx="32" cy="35" rx="17" ry="22" fill="#202124"/>
  <ellipse cx="32" cy="40" rx="12" ry="14" fill="#f5f5f2"/>
  <circle cx="27" cy="24" r="5" fill="white"/><circle cx="37" cy="24" r="5" fill="white"/>
  <circle cx="28" cy="25" r="2"/><circle cx="36" cy="25" r="2"/>
  <path d="M27 31l5-4 5 4-5 4z" fill="#f28c28"/><path d="M16 55h14l-7-5zM34 55h14l-7-5z" fill="#f28c28"/>
</svg>`,
} as const;

export const SHOWCASE_PROJECTS = [
  {
    id: "t3code",
    title: "T3 Code",
    directory: "t3code",
    repositoryUrl: "https://github.com/pingdotgg/t3code.git",
    favicon: PROJECT_FAVICONS.t3code,
  },
  {
    id: "react",
    title: "React",
    directory: "react",
    repositoryUrl: "https://github.com/facebook/react.git",
    favicon: PROJECT_FAVICONS.react,
  },
  {
    id: "linux",
    title: "Linux",
    directory: "linux",
    repositoryUrl: "https://github.com/torvalds/linux.git",
    favicon: PROJECT_FAVICONS.linux,
  },
] as const;

export const SHOWCASE_ENVIRONMENTS = [
  {
    id: "moonbase-terminal",
    label: "Moonbase Terminal",
    projectIds: ["t3code"],
  },
  {
    id: "suspense-station",
    label: "Suspense Station",
    projectIds: ["react"],
  },
  {
    id: "kernel-cabin",
    label: "Kernel Cabin",
    projectIds: ["linux"],
  },
] as const;

export const SHOWCASE_THREADS = [
  {
    id: SHOWCASE_THREAD_ID,
    projectId: "t3code",
    title: "Make remote coding feel local ✦",
    branch: "feat/remote-command-center",
    minutesAgo: 3,
    request:
      "Give T3 Code a remote-first command center. Make three machines feel one tap away, keep agent work in sync, and make every handoff feel instant.",
    response:
      "T3 Code now treats every machine like it is right here in the room. ✦\n\n- Moonbase, Suspense Station, and Kernel Cabin stay live together\n- Terminal state follows you without losing a single line\n- Agent work remains perfectly in sync across devices\n- Handoffs land before your train of thought can wander\n\nI also ran the changed workspace: **612 tests passed**.",
  },
  {
    id: "pocket-command-center",
    projectId: "t3code",
    title: "Put the command center in your pocket",
    branch: "feat/pocket-command-center",
    minutesAgo: 21,
    state: "approval" as const,
    request: "Make switching between desktop, phone, and tablet feel like one continuous session.",
    response:
      "The handoff flow preserves the selected thread, terminal buffer, and working diff. The final motion treatment is ready for approval.",
  },
  {
    id: "buttery-suspense",
    projectId: "react",
    title: "Make Suspense transitions buttery",
    branch: "perf/buttery-suspense",
    minutesAgo: 12,
    state: "working" as const,
    request:
      "Trace the last few dropped frames in nested Suspense transitions and make them disappear.",
    response: null,
  },
  {
    id: "hydration-haikus",
    projectId: "react",
    title: "Turn hydration warnings into haikus",
    branch: "dev/hydration-haikus",
    minutesAgo: 44,
    request:
      "Keep hydration errors precise, but make the development copy unexpectedly delightful.",
    response:
      "The diagnostics still lead with the exact mismatch and component stack. A tiny optional haiku now closes the expanded explanation.",
    snoozeMinutes: 90,
  },
  {
    id: "beautiful-boot",
    projectId: "linux",
    title: "Make boot logs oddly beautiful",
    branch: "feat/beautiful-boot",
    minutesAgo: 34,
    state: "plan" as const,
    request:
      "Design a clearer boot timeline that remains useful over serial and never hides kernel detail.",
    response:
      "The plan groups milestones without changing the underlying log stream, preserves plain-text output, and adds zero work to the hot path.",
  },
  {
    id: "patient-penguins",
    projectId: "linux",
    title: "Teach penguins to wait patiently",
    branch: "feat/patient-penguins",
    minutesAgo: 52,
    request: "Make delayed work easier to follow without adding noise to the scheduler trace.",
    response:
      "Delayed work now carries a concise reason through the trace, so the wait is legible without changing scheduling behavior.",
    snoozeMinutes: 8 * 60,
  },
  {
    id: "handoff-haptics",
    projectId: "t3code",
    title: "Tune the handoff haptics",
    branch: "feat/handoff-haptics",
    minutesAgo: 5 * 60,
    settled: true,
    request: "Give the desktop-to-phone handoff a haptic that lands with the animation.",
    response:
      "The handoff now taps once as the thread lands and stays silent on failure, so the phone never celebrates a handoff that did not happen.",
  },
  {
    id: "streaming-shell",
    projectId: "react",
    title: "Stream the shell before the data",
    branch: "feat/streaming-shell",
    minutesAgo: 28 * 60,
    settled: true,
    request: "Get the app shell painted before any data request resolves.",
    response:
      "The shell now flushes on first byte and the data boundaries hydrate underneath it, so the first paint no longer waits on the slowest query.",
  },
  {
    id: "quieter-oom",
    projectId: "linux",
    title: "Make the OOM killer explain itself",
    branch: "feat/quieter-oom",
    minutesAgo: 2 * 24 * 60,
    settled: true,
    request: "Make out-of-memory kills legible without adding a single allocation to the hot path.",
    response:
      "Kills now report the winning heuristic and the runner-up alongside the usual dump, assembled entirely from data the path already had.",
  },
] as const;

export type ShowcaseLiveStep =
  | {
      readonly type: "message";
      readonly text: string;
      readonly phase?: "commentary" | "final_answer";
      /** Stop partway through and keep the turn running, for a streaming capture. */
      readonly hold?: boolean;
    }
  | {
      readonly type: "command";
      readonly command: string;
      readonly output: string;
      readonly exitCode?: number;
      readonly durationMs?: number;
      /** Keep running after the turn ends, which the app shows as background work. */
      readonly background?: boolean;
    }
  | {
      readonly type: "fileChange";
      readonly changes: ReadonlyArray<{
        readonly path: string;
        readonly kind: "add" | "update";
        readonly diff: string;
      }>;
    }
  | {
      readonly type: "approval";
      readonly command: string;
      readonly reason: string;
      readonly output: string;
    }
  | {
      readonly type: "question";
      readonly questions: ReadonlyArray<{
        readonly id: string;
        readonly header: string;
        readonly question: string;
        readonly options: ReadonlyArray<{ readonly label: string; readonly description: string }>;
      }>;
    };

const RECONNECT_BANNER_DIFF = `@@ -0,0 +1,24 @@
+import { Text, View } from "react-native";
+
+import { useReconnectState } from "./useReconnectState";
+
+export function ReconnectBanner(props: { readonly environmentId: string }) {
+  const state = useReconnectState(props.environmentId);
+  if (state.status === "connected") return null;
+  return (
+    <View className="flex-row items-center gap-2 px-4 py-2">
+      <Text className="text-sm font-medium">
+        {state.status === "retrying"
+          ? \`Reconnecting in \${state.secondsLeft}s\`
+          : "Connection lost"}
+      </Text>
+    </View>
+  );
+}
`;

const RECONNECT_STATE_DIFF = `@@ -12,9 +12,17 @@ export function useReconnectState(environmentId: string) {
   const connection = useEnvironmentConnection(environmentId);
-  const [attempt, setAttempt] = useState(0);
+  const [attempt, setAttempt] = useState(0);
+  const delayMs = Math.min(30_000, 1_000 * 2 ** attempt);
   useEffect(() => {
-    if (connection.status !== "lost") return;
-    const timer = setTimeout(() => connection.retry(), 1_000);
+    if (connection.status !== "lost") {
+      setAttempt(0);
+      return;
+    }
+    const timer = setTimeout(() => {
+      setAttempt((value) => value + 1);
+      connection.retry();
+    }, delayMs);
     return () => clearTimeout(timer);
-  }, [connection]);
+  }, [connection, delayMs]);
`;

const LONG_CODE_ANSWER = `Here is the retry helper. It keeps one timer per environment, backs off to 30 seconds, and resets after a clean reconnect.

\`\`\`ts
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

export interface ReconnectOptions {
  readonly environmentId: string;
  readonly maxDelay?: Duration.Duration;
  readonly onAttempt?: (attempt: number, delay: Duration.Duration) => void;
}

const DEFAULT_MAX_DELAY = Duration.seconds(30);

/** Exponential backoff with jitter, capped, that never gives up on a paired environment. */
export function reconnectSchedule(options: ReconnectOptions) {
  const maxDelay = options.maxDelay ?? DEFAULT_MAX_DELAY;
  return Schedule.exponential(Duration.seconds(1), 2).pipe(
    Schedule.jittered,
    Schedule.modifyDelay((_, delay) => Duration.min(delay, maxDelay)),
    Schedule.tapOutput((delay) =>
      Effect.sync(() => options.onAttempt?.(Schedule.CurrentIterationMetadata.attempt, delay)),
    ),
  );
}

export const reconnect = Effect.fn("Environment.reconnect")(function* (
  options: ReconnectOptions,
  connect: Effect.Effect<void, ConnectionError>,
) {
  yield* Effect.logInfo("Reconnecting", { environmentId: options.environmentId });
  yield* connect.pipe(Effect.retry(reconnectSchedule(options)));
  yield* Effect.logInfo("Reconnected", { environmentId: options.environmentId });
});

export class ConnectionError extends Error {
  readonly _tag = "ConnectionError";
  constructor(
    readonly environmentId: string,
    readonly reason: "timeout" | "refused" | "auth",
  ) {
    super(\`\${environmentId} could not connect: \${reason}\`);
  }
}
\`\`\`

Wire it into \`useEnvironmentConnection\` so the banner reads \`attempt\` and \`delay\` from the same schedule.`;

/**
 * Threads the scripted provider (mobile-showcase-provider.ts) runs live, so captures show real
 * runs: tool calls, a diff, a long code block, a stream in progress, an approval, a question and
 * background work. Each one starts with its prompt; the provider plays the steps that match.
 */
export const SHOWCASE_LIVE_THREADS = [
  {
    id: "tool-calls",
    projectId: "t3code",
    title: "Show a reconnect banner",
    prompt: "Show a banner when an environment drops, and retry with backoff.",
    steps: [
      {
        type: "message",
        phase: "commentary",
        text: "I'll find where connection state lives, then add the banner and backoff.",
      },
      {
        type: "command",
        command: 'rg -n "useEnvironmentConnection" apps/mobile/src',
        output:
          "apps/mobile/src/features/home/HomeRouteScreen.tsx:41:  const connection = useEnvironmentConnection(environmentId);\napps/mobile/src/features/connection/useReconnectState.ts:12:  const connection = useEnvironmentConnection(environmentId);\n",
        durationMs: 180,
      },
      {
        type: "fileChange",
        changes: [
          {
            path: "apps/mobile/src/features/connection/ReconnectBanner.tsx",
            kind: "add",
            diff: RECONNECT_BANNER_DIFF,
          },
          {
            path: "apps/mobile/src/features/connection/useReconnectState.ts",
            kind: "update",
            diff: RECONNECT_STATE_DIFF,
          },
        ],
      },
      {
        type: "command",
        command: "vp test run apps/mobile/src/features/connection",
        output:
          " ✓ useReconnectState.test.ts (9 tests) 41ms\n ✓ ReconnectBanner.test.ts (4 tests) 18ms\n\n Test Files  2 passed (2)\n      Tests  13 passed (13)\n",
        durationMs: 3_400,
      },
      {
        type: "message",
        text: "The banner now appears as soon as an environment drops and counts down to the next retry.\n\n- Backoff doubles from 1s and caps at 30s\n- A clean reconnect resets the counter\n- 13 tests pass in `features/connection`",
      },
    ],
  },
  {
    id: "long-code",
    projectId: "t3code",
    title: "Write the reconnect schedule",
    prompt: "Write the reconnect schedule as an Effect helper with jittered backoff.",
    steps: [{ type: "message", text: LONG_CODE_ANSWER }],
  },
  {
    id: "streaming",
    projectId: "t3code",
    title: "Cut thread list render cost",
    prompt: "Profile the thread list and cut the cost of each row render.",
    steps: [
      {
        type: "message",
        phase: "commentary",
        text: "Measuring the row renders first, so the change has a baseline.",
      },
      {
        type: "command",
        command: "vp run render-metrics --surface thread-list",
        output:
          "thread-list  rows: 240  mean: 3.8ms  p95: 9.6ms  commits: 612\n  ThreadRow       2.9ms  (memo miss: relative time label)\n  ProjectFavicon  0.6ms\n",
        durationMs: 8_200,
      },
      {
        type: "message",
        hold: true,
        text: "Most of the cost is the relative time label. Every row re-renders once a minute because each label owns its own timer.\n\n1. **Share one clock.** A single minute ticker at the list level, read through context, so rows only re-render when their own label text changes.\n2. **Memo the row on its shell.** `ThreadRow` gets the thread shell and the label string, not the whole entity.\n3. **Keep favicons out of the row commit.**",
      },
    ],
  },
  {
    id: "approval",
    projectId: "t3code",
    title: "Reset the Metro cache",
    prompt: "Clear the stale Metro cache and restart the bundler.",
    steps: [
      {
        type: "message",
        phase: "commentary",
        text: "The bundle hash is stale. Clearing the cache needs a delete outside the source tree.",
      },
      {
        type: "approval",
        command: "rm -rf apps/mobile/.expo apps/mobile/node_modules/.cache",
        reason: "Delete cached Metro bundles so the next start rebuilds them.",
        output: "",
      },
      {
        type: "message",
        text: "Cache cleared. The next `vp run dev:client` rebuilds the bundle from scratch.",
      },
    ],
  },
  {
    id: "question",
    projectId: "react",
    title: "Plan offline mode",
    prompt: "Add an offline mode for the thread list.",
    steps: [
      {
        type: "message",
        phase: "commentary",
        text: "Two choices change the design, so I'll ask before writing code.",
      },
      {
        type: "question",
        questions: [
          {
            id: "cache_scope",
            header: "Cache",
            question: "How much history should the phone keep offline?",
            options: [
              {
                label: "Last 50 threads (Recommended)",
                description: "Fast to load and small on disk. Older threads load when online.",
              },
              { label: "Pinned threads only", description: "The smallest cache." },
              { label: "Everything", description: "Full history, at the cost of storage." },
            ],
          },
          {
            id: "conflicts",
            header: "Sync",
            question: "When the connection returns, which version wins?",
            options: [
              {
                label: "Server state (Recommended)",
                description: "Local drafts stay, everything else follows the server.",
              },
              { label: "Ask me each time", description: "Show a prompt for each conflict." },
            ],
          },
        ],
      },
      {
        type: "message",
        text: "Thanks. I'll cache the last 50 threads and let the server win on reconnect.",
      },
    ],
  },
  {
    id: "background",
    projectId: "t3code",
    title: "Check settings in the dev server",
    prompt: "Start the web dev server and keep it running while you check the settings page.",
    steps: [
      {
        type: "command",
        command: "vp run dev --filter web",
        background: true,
        output:
          "  VITE v7.1.1  ready in 1.24s\n\n  ➜  Local:   http://127.0.0.1:5173/\n  ➜  press h + enter to show help\n",
      },
      {
        type: "message",
        text: "The dev server is running in the background on port 5173. Settings renders without console errors; I left the server up so you can open it.",
      },
    ],
  },
] as const satisfies ReadonlyArray<{
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly prompt: string;
  readonly steps: ReadonlyArray<ShowcaseLiveStep>;
}>;

export type ShowcaseLiveThreadId = (typeof SHOWCASE_LIVE_THREADS)[number]["id"];

/**
 * Points the environment's only provider at the scripted Codex peer, so the model picker and
 * every run are the same on every machine. Call before the server starts.
 */
export async function writeShowcaseProviderSettings(baseDir: string): Promise<void> {
  const binDirectory = NodePath.join(baseDir, "showcase-bin");
  const codexPath = NodePath.join(binDirectory, "codex");
  const providerScript = NodePath.join(import.meta.dirname, "mobile-showcase-provider.ts");
  await NodeFSP.mkdir(binDirectory, { recursive: true });
  await NodeFSP.writeFile(
    codexPath,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(providerScript)} "$@"\n`,
    { mode: 0o755 },
  );
  await NodeFSP.mkdir(NodePath.join(baseDir, "userdata"), { recursive: true });
  await NodeFSP.writeFile(
    NodePath.join(baseDir, "userdata", "settings.json"),
    `${JSON.stringify(
      {
        providerInstances: {
          codex: { driver: "codex", enabled: true, config: { binaryPath: codexPath } },
          // The only other provider on by default.
          claudeAgent: { driver: "claudeAgent", enabled: false },
        },
      },
      null,
      2,
    )}\n`,
  );
}

/** The server lists itself for the CLI a moment after it starts listening; retry until then. */
async function launchThreadWhenServerIsUp(
  launch: () => Promise<{ readonly stdout: string }>,
): Promise<string> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return (await launch()).stdout;
    } catch (error) {
      const notListed = String((error as { stderr?: unknown }).stderr ?? "").includes(
        "No running T3 Code server",
      );
      if (!notListed || attempt >= 40) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}

/** Starts each live thread whose project this environment owns; returns their thread ids. */
export async function startShowcaseLiveThreads(input: {
  readonly baseDir: string;
  readonly projectIds: ReadonlyArray<string>;
  readonly repoRoot: string;
}): Promise<ReadonlyMap<ShowcaseLiveThreadId, string>> {
  const threads = SHOWCASE_LIVE_THREADS.filter((thread) =>
    input.projectIds.includes(thread.projectId),
  );
  const launched = await Promise.all(
    threads.map(async (thread) => {
      const stdout = await launchThreadWhenServerIsUp(() => {
        const launch = execFile(
          process.execPath,
          [
            "apps/server/src/bin.ts",
            "thread",
            "start",
            thread.projectId,
            thread.prompt,
            "--title",
            thread.title,
            "--base-dir",
            input.baseDir,
            "--json",
          ],
          { cwd: input.repoRoot, env: { ...process.env, NO_COLOR: "1" } },
        );
        // The CLI reads a piped stdin to its end, so close it.
        launch.child.stdin?.end();
        return launch;
      });
      const { threadId } = JSON.parse(
        stdout.slice(stdout.indexOf("{"), stdout.lastIndexOf("}") + 1),
      ) as { readonly threadId?: string };
      if (!threadId) throw new Error(`Live thread '${thread.id}' did not start.`);
      return [thread.id, threadId] as const;
    }),
  );
  return new Map(launched);
}

function minutesBefore(now: number, minutes: number): string {
  return new Date(now - minutes * 60_000).toISOString();
}

async function runGit(workspaceRoot: string, args: ReadonlyArray<string>): Promise<void> {
  await execFile("git", [...args], {
    cwd: workspaceRoot,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Alex Rivera",
      GIT_AUTHOR_EMAIL: "alex@lumen.test",
      GIT_COMMITTER_NAME: "Alex Rivera",
      GIT_COMMITTER_EMAIL: "alex@lumen.test",
    },
  });
}

async function initializeRepository(input: {
  readonly workspaceRoot: string;
  readonly repositoryUrl: string;
  readonly commitMessage: string;
}): Promise<void> {
  await runGit(input.workspaceRoot, ["init", "-b", "main"]);
  await runGit(input.workspaceRoot, ["remote", "add", "origin", input.repositoryUrl]);
  await runGit(input.workspaceRoot, ["add", "."]);
  await runGit(input.workspaceRoot, ["commit", "-m", input.commitMessage]);
}

async function seedT3CodeWorkspace(workspaceRoot: string): Promise<void> {
  await NodeFSP.mkdir(NodePath.join(workspaceRoot, "apps/mobile/src/features/home"), {
    recursive: true,
  });
  await NodeFSP.writeFile(
    NodePath.join(workspaceRoot, "package.json"),
    `${JSON.stringify({ name: "t3code", private: true, scripts: { test: "vp test" } }, null, 2)}\n`,
  );
  await NodeFSP.writeFile(NodePath.join(workspaceRoot, "favicon.svg"), PROJECT_FAVICONS.t3code);
  await NodeFSP.writeFile(
    NodePath.join(workspaceRoot, "apps/mobile/src/features/home/environmentPresence.ts"),
    BASE_ENVIRONMENT_PRESENCE,
  );
  await initializeRepository({
    workspaceRoot,
    repositoryUrl: "https://github.com/pingdotgg/t3code.git",
    commitMessage: "Show connected environments",
  });
  await runGit(workspaceRoot, ["checkout", "-b", "feat/remote-command-center"]);
  await NodeFSP.writeFile(
    NodePath.join(workspaceRoot, "apps/mobile/src/features/home/environmentPresence.ts"),
    UPDATED_ENVIRONMENT_PRESENCE,
  );
  await NodeFSP.writeFile(
    NodePath.join(workspaceRoot, "apps/mobile/src/features/home/RemoteHandoffCard.tsx"),
    REMOTE_HANDOFF_CARD,
  );
}

async function seedCompanionWorkspace(input: {
  readonly workspaceRoot: string;
  readonly title: string;
  readonly repositoryUrl: string;
  readonly favicon: string;
}): Promise<void> {
  await NodeFSP.mkdir(input.workspaceRoot, { recursive: true });
  await NodeFSP.writeFile(NodePath.join(input.workspaceRoot, "favicon.svg"), input.favicon);
  await NodeFSP.writeFile(
    NodePath.join(input.workspaceRoot, "README.md"),
    `# ${input.title}\n\nSeeded by the T3 Code mobile screenshot harness.\n`,
  );
  await initializeRepository({
    workspaceRoot: input.workspaceRoot,
    repositoryUrl: input.repositoryUrl,
    commitMessage: `Seed ${input.title} workspace`,
  });
}

function insertThread(
  database: NodeSqlite.DatabaseSync,
  now: number,
  input: {
    readonly id: string;
    readonly projectId: string;
    readonly title: string;
    readonly branch: string;
    readonly minutesAgo: number;
    readonly state?: "working" | "approval" | "plan";
    readonly settled?: boolean;
    readonly snoozeMinutes?: number;
    readonly workspaceRoot: string;
  },
): void {
  const turnId = `${input.id}-turn`;
  const updatedAt = minutesBefore(now, input.minutesAgo);
  const isWorking = input.state === "working";
  const snoozedUntil =
    input.snoozeMinutes === undefined
      ? null
      : new Date(now + input.snoozeMinutes * 60_000).toISOString();
  const snoozedAt =
    input.snoozeMinutes === undefined
      ? null
      : minutesBefore(now, Math.max(1, Math.floor(input.minutesAgo / 2)));
  database
    .prepare(
      `INSERT INTO projection_threads (
        thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
        branch, worktree_path, latest_turn_id, latest_user_message_at, pending_approval_count,
        pending_user_input_count, has_actionable_proposed_plan, created_at, updated_at,
        archived_at, deleted_at, settled_override, settled_at, snoozed_until, snoozed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, NULL, NULL, ?, ?, ?, ?)`,
    )
    .run(
      input.id,
      input.projectId,
      input.title,
      MODEL_SELECTION,
      "full-access",
      input.state === "plan" ? "plan" : "default",
      input.branch,
      input.workspaceRoot,
      turnId,
      minutesBefore(now, input.minutesAgo + 1),
      input.state === "approval" ? 1 : 0,
      input.state === "plan" ? 1 : 0,
      minutesBefore(now, input.minutesAgo + 120),
      updatedAt,
      input.settled ? "settled" : null,
      input.settled ? updatedAt : null,
      snoozedUntil,
      snoozedAt,
    );
  database
    .prepare(
      `INSERT INTO projection_thread_sessions (
        thread_id, status, provider_name, provider_instance_id, provider_session_id,
        provider_thread_id, runtime_mode, active_turn_id, last_error, updated_at
      ) VALUES (?, ?, 'Codex', 'codex', NULL, NULL, 'full-access', ?, NULL, ?)`,
    )
    .run(input.id, isWorking ? "running" : "ready", isWorking ? turnId : null, updatedAt);
}

// V2 still owns projection_projects; upsert project rows without deleting them with V1 thread data.
const SEEDED_V1_TABLES = [
  "projection_thread_messages",
  "projection_thread_sessions",
  "projection_threads",
] as const;

const SEEDED_PROJECTION_TABLES = [...SEEDED_V1_TABLES, "projection_projects"] as const;

const SEEDED_THREAD_COLUMNS = ["snoozed_until", "snoozed_at"] as const;

function hasSeedableSchema(dbPath: string): boolean {
  let database: NodeSqlite.DatabaseSync;
  try {
    database = new NodeSqlite.DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return false;
  }
  try {
    const tableCount = database
      .prepare(
        `SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name IN (${SEEDED_PROJECTION_TABLES.map(() => "?").join(", ")})`,
      )
      .get(...SEEDED_PROJECTION_TABLES) as { count: number };
    if (tableCount.count !== SEEDED_PROJECTION_TABLES.length) return false;

    const threadColumns = database.prepare("PRAGMA table_info(projection_threads)").all() as Array<{
      name: string;
    }>;
    const threadColumnNames = new Set(threadColumns.map((column) => column.name));
    return SEEDED_THREAD_COLUMNS.every((column) => threadColumnNames.has(column));
  } catch {
    return false;
  } finally {
    database.close();
  }
}

async function waitForSeedableSchema(dbPath: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (hasSeedableSchema(dbPath)) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`The environment server did not migrate ${dbPath} within ${timeoutMs}ms.`);
}

function seedDatabase(
  dbPath: string,
  workspaceRoots: ReadonlyMap<string, string>,
  projects: ReadonlyArray<(typeof SHOWCASE_PROJECTS)[number]>,
  threads: ReadonlyArray<(typeof SHOWCASE_THREADS)[number]>,
  now: number,
): void {
  // The running server writes migrations/projections concurrently; wait for its lock instead of failing SQLITE_BUSY.
  const database = new NodeSqlite.DatabaseSync(dbPath, { timeout: 30_000 });
  try {
    database.exec("BEGIN IMMEDIATE");
    for (const table of SEEDED_V1_TABLES) {
      database.exec(`DELETE FROM ${table}`);
    }
    const insertProject = database.prepare(
      `INSERT OR REPLACE INTO projection_projects (
          project_id, title, workspace_root, default_model_selection_json, scripts_json,
          created_at, updated_at, deleted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
    );
    for (const [index, project] of projects.entries()) {
      const workspaceRoot = workspaceRoots.get(project.id);
      if (!workspaceRoot) throw new Error(`Missing workspace root for ${project.id}.`);
      const latestThreadMinutes = Math.min(
        ...threads
          .filter((thread) => thread.projectId === project.id)
          .map((thread) => thread.minutesAgo),
      );
      insertProject.run(
        project.id,
        project.title,
        workspaceRoot,
        MODEL_SELECTION,
        PROJECT_SCRIPTS,
        minutesBefore(now, 60 * 24 * (90 - index * 12)),
        minutesBefore(now, latestThreadMinutes),
      );
    }

    for (const thread of threads) {
      const workspaceRoot = workspaceRoots.get(thread.projectId);
      if (!workspaceRoot) throw new Error(`Missing workspace root for ${thread.projectId}.`);
      insertThread(database, now, {
        ...thread,
        ...("state" in thread ? { state: thread.state } : {}),
        workspaceRoot,
      });
    }

    const insertMessage = database.prepare(
      `INSERT INTO projection_thread_messages (
        message_id, thread_id, turn_id, role, text, is_streaming, attachments_json,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 0, NULL, ?, ?)`,
    );
    for (const thread of threads) {
      const turnId = `${thread.id}-turn`;
      const requestTime = minutesBefore(now, thread.minutesAgo + 5);
      insertMessage.run(
        `${thread.id}-request`,
        thread.id,
        turnId,
        "user",
        thread.request,
        requestTime,
        requestTime,
      );
      if (thread.response !== null) {
        const responseTime = minutesBefore(now, thread.minutesAgo);
        insertMessage.run(
          `${thread.id}-answer`,
          thread.id,
          turnId,
          "assistant",
          thread.response,
          responseTime,
          responseTime,
        );
      }
    }

    database.exec("COMMIT");
  } catch (error) {
    // Failed BEGIN or automatic rollback leaves no transaction; preserve the original error if rollback fails.
    try {
      database.exec("ROLLBACK");
    } catch {}
    throw error;
  } finally {
    database.close();
  }
}

export async function seedShowcaseEnvironment(input: {
  readonly baseDir: string;
  readonly projectIds?: ReadonlyArray<string>;
  readonly now?: number;
}): Promise<{ readonly dbPath: string; readonly workspaceRoot: string }> {
  const now = input.now ?? Date.now();
  const selectedProjectIds = new Set(
    input.projectIds ?? SHOWCASE_PROJECTS.map((project) => project.id),
  );
  const projects = SHOWCASE_PROJECTS.filter((project) => selectedProjectIds.has(project.id));
  if (projects.length === 0) throw new Error("At least one showcase project must be selected.");
  const threads = SHOWCASE_THREADS.filter((thread) => selectedProjectIds.has(thread.projectId));
  const workspaceBase = NodePath.join(input.baseDir, "workspace");
  const workspaceRoots = new Map(
    projects.map(
      (project) => [project.id, NodePath.join(workspaceBase, project.directory)] as const,
    ),
  );
  const primaryProject =
    projects.find((project) => project.id === SHOWCASE_PROJECT_ID) ?? projects[0];
  if (!primaryProject) throw new Error("The primary showcase workspace is not configured.");
  const workspaceRoot = workspaceRoots.get(primaryProject.id);
  if (!workspaceRoot) throw new Error("The primary showcase workspace is not configured.");
  const dbPath = NodePath.join(input.baseDir, "userdata", "statev2.sqlite");
  if (primaryProject.id === SHOWCASE_PROJECT_ID) {
    await seedT3CodeWorkspace(workspaceRoot);
  }
  await Promise.all(
    projects
      .filter((project) => project.id !== SHOWCASE_PROJECT_ID)
      .map(async (project) => {
        const projectWorkspaceRoot = workspaceRoots.get(project.id);
        if (!projectWorkspaceRoot) throw new Error(`Missing workspace root for ${project.id}.`);
        await seedCompanionWorkspace({
          workspaceRoot: projectWorkspaceRoot,
          title: project.title,
          repositoryUrl: project.repositoryUrl,
          favicon: project.favicon,
        });
      }),
  );
  // Listening precedes migration completion; wait for the schema before reseeding.
  await waitForSeedableSchema(dbPath);
  seedDatabase(dbPath, workspaceRoots, projects, threads, now);

  const terminalDirectory = NodePath.join(input.baseDir, "userdata", "logs", "terminals");
  if (selectedProjectIds.has(SHOWCASE_PROJECT_ID)) {
    const safeThreadId = Buffer.from(SHOWCASE_THREAD_ID).toString("base64url");
    await NodeFSP.mkdir(terminalDirectory, { recursive: true });
    await NodeFSP.writeFile(
      NodePath.join(terminalDirectory, `terminal_${safeThreadId}.log`),
      SHOWCASE_TERMINAL_BUFFER,
    );
  }
  return { dbPath, workspaceRoot };
}
