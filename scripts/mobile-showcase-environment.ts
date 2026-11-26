// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off - This host-side fixture creates an isolated local Hyakki environment.
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
  <rect width="128" height="128" rx="28" fill="#171717"/>
  <svg x="22" y="26" width="84" height="73" viewBox="0 0 556 482"><g transform="matrix(0.025 0 0 -0.025 0 482)"><path fill="#ebe2d6" d="M11527 18873 c-4 -3 -7 -16 -7 -28 0 -12 -9 -34 -20 -48 -11 -14 -20 -40 -20 -60 0 -21 -7 -41 -20 -52 -13 -12 -20 -31 -20 -55 0 -22 -8 -48 -20 -63 -11 -14 -20 -37 -20 -52 0 -15 -9 -38 -20 -52 -11 -14 -20 -40 -20 -58 0 -19 -8 -39 -20 -50 -12 -11 -20 -31 -20 -50 0 -18 -9 -44 -20 -58 -11 -14 -20 -38 -20 -55 0 -16 -9 -41 -20 -55 -11 -14 -20 -38 -20 -54 0 -15 -9 -41 -20 -58 -11 -16 -20 -43 -20 -58 0 -16 -9 -40 -20 -54 -11 -14 -20 -40 -20 -58 0 -18 -9 -44 -20 -58 -11 -14 -20 -40 -20 -60 0 -21 -7 -41 -20 -52 -12 -11 -20 -31 -20 -49 0 -17 -9 -42 -20 -56 -11 -14 -20 -38 -20 -53 0 -16 -9 -40 -20 -54 -11 -14 -20 -40 -20 -58 0 -19 -8 -39 -20 -50 -13 -11 -20 -31 -20 -52 0 -20 -9 -46 -20 -60 -11 -14 -20 -37 -20 -52 0 -14 -9 -39 -20 -56 -11 -16 -20 -43 -20 -60 0 -16 -9 -41 -20 -55 -11 -14 -20 -38 -20 -55 0 -16 -9 -43 -20 -60 -11 -16 -20 -44 -20 -61 0 -18 -8 -38 -20 -49 -12 -11 -20 -31 -20 -50 0 -18 -9 -44 -20 -58 -11 -14 -20 -38 -20 -54 0 -15 -9 -41 -20 -58 -11 -16 -20 -41 -20 -55 0 -14 -9 -38 -20 -55 -11 -16 -20 -43 -20 -60 0 -16 -9 -43 -20 -60 -11 -16 -20 -43 -20 -58 0 -16 -9 -40 -20 -54 -11 -15 -20 -41 -20 -60 0 -20 -9 -46 -20 -60 -11 -15 -20 -41 -20 -60 0 -20 -9 -46 -20 -60 -11 -15 -20 -41 -20 -60 0 -20 -9 -46 -20 -60 -11 -14 -20 -40 -20 -57 0 -17 -9 -44 -20 -61 -11 -16 -20 -43 -20 -59 0 -23 -25 -78 -48 -106 -2 -3 -540 -5 -1195 -6 -656 0 -1399 -1 -1653 -2 l-461 -2 -44 -43 c-85 -83 -298 -313 -354 -382 -31 -38 -98 -113 -148 -165 -50 -52 -122 -132 -158 -176 -63 -76 -160 -183 -254 -278 -22 -23 -60 -66 -85 -96 -51 -63 -193 -223 -248 -279 -20 -21 -80 -89 -134 -152 -53 -63 -160 -179 -237 -259 -115 -118 -141 -150 -139 -170 l3 -25 2213 -3 c2418 -2 2250 2 2203 -58 -12 -15 -21 -39 -21 -53 0 -14 -9 -43 -20 -64 -11 -20 -20 -47 -20 -60 0 -12 -9 -39 -20 -60 -11 -20 -20 -46 -20 -57 0 -12 -9 -38 -20 -60 -11 -22 -20 -49 -20 -60 0 -11 -9 -38 -20 -60 -11 -22 -20 -46 -20 -55 0 -9 -9 -33 -20 -55 -11 -22 -20 -47 -20 -57 0 -10 -9 -35 -20 -56 -11 -20 -20 -45 -20 -55 0 -9 -9 -34 -20 -55 -11 -20 -20 -49 -20 -65 0 -15 -7 -38 -17 -51 -9 -13 -20 -44 -25 -69 -4 -25 -15 -53 -23 -62 -8 -9 -15 -28 -15 -41 0 -13 -9 -41 -20 -62 -11 -20 -20 -47 -20 -60 0 -12 -9 -39 -20 -60 -11 -20 -20 -47 -20 -60 0 -12 -9 -40 -20 -62 -11 -22 -20 -47 -20 -57 0 -10 -8 -37 -19 -60 -17 -40 -25 -62 -53 -143 -6 -16 -19 -48 -29 -70 -10 -22 -20 -57 -23 -79 -3 -21 -11 -46 -19 -55 -8 -9 -17 -33 -20 -55 -3 -21 -13 -46 -22 -56 -8 -9 -15 -30 -15 -46 0 -16 -9 -44 -20 -62 -11 -18 -20 -40 -20 -50 0 -9 -9 -34 -20 -55 -11 -20 -20 -47 -20 -59 -1 -13 -9 -41 -20 -63 -11 -22 -20 -49 -20 -60 0 -11 -9 -33 -20 -50 -11 -16 -20 -42 -20 -56 0 -15 -9 -38 -20 -52 -11 -14 -20 -34 -20 -44 0 -10 -9 -35 -20 -56 -11 -20 -20 -48 -20 -61 0 -13 -9 -35 -20 -49 -11 -14 -20 -36 -20 -49 0 -12 -9 -38 -20 -56 -11 -18 -20 -42 -20 -53 0 -11 -9 -37 -20 -59 -11 -22 -20 -47 -20 -57 0 -10 -9 -31 -20 -48 -11 -16 -20 -39 -20 -50 0 -11 -9 -35 -20 -53 -11 -18 -20 -40 -20 -50 0 -9 -9 -30 -20 -47 -11 -16 -20 -39 -20 -50 0 -11 -9 -33 -20 -50 -11 -16 -20 -37 -20 -46 0 -9 -9 -28 -20 -42 -11 -14 -20 -32 -20 -41 0 -16 -27 -82 -61 -148 -10 -20 -19 -46 -19 -56 0 -11 -9 -31 -20 -45 -11 -14 -20 -33 -20 -44 0 -10 -9 -31 -20 -48 -11 -16 -20 -40 -20 -51 0 -12 -9 -33 -20 -47 -11 -14 -20 -32 -20 -40 0 -8 -9 -26 -20 -40 -11 -14 -20 -34 -20 -45 0 -10 -9 -31 -20 -45 -11 -14 -20 -33 -20 -44 0 -10 -9 -29 -20 -43 -11 -14 -20 -33 -20 -43 0 -15 -19 -58 -52 -117 -4 -8 -13 -26 -19 -40 -27 -62 -53 -118 -70 -152 -11 -20 -19 -45 -19 -55 0 -10 -9 -31 -20 -48 -11 -16 -20 -37 -20 -46 0 -9 -9 -28 -20 -42 -11 -14 -20 -34 -20 -45 0 -10 -9 -29 -20 -42 -11 -13 -20 -31 -20 -40 0 -10 -9 -29 -20 -43 -11 -14 -20 -34 -20 -45 0 -10 -9 -31 -20 -45 -11 -14 -20 -33 -20 -42 0 -9 -10 -35 -22 -58 -12 -23 -25 -50 -30 -59 -4 -10 -12 -26 -16 -35 -5 -10 -18 -37 -30 -60 -12 -23 -22 -50 -22 -61 0 -10 -9 -27 -20 -37 -11 -10 -20 -28 -20 -40 0 -12 -9 -34 -20 -48 -11 -14 -20 -34 -20 -45 0 -12 -5 -24 -11 -28 -6 -3 -19 -25 -29 -49 -10 -24 -23 -46 -29 -49 -6 -4 -11 -16 -11 -28 0 -11 -9 -31 -20 -45 -11 -14 -20 -32 -20 -40 0 -8 -9 -26 -20 -40 -11 -14 -20 -32 -20 -40 0 -12 -21 -57 -52 -113 -4 -8 -13 -26 -19 -40 -20 -43 -154 -311 -180 -360 -5 -8 -24 -47 -44 -86 -19 -40 -42 -77 -50 -84 -8 -7 -15 -20 -15 -30 0 -9 -9 -25 -20 -35 -11 -10 -20 -26 -20 -36 0 -10 -6 -24 -14 -32 -8 -7 -28 -40 -45 -73 -18 -32 -39 -62 -47 -67 -7 -4 -14 -16 -14 -26 0 -9 -18 -42 -40 -71 -22 -29 -40 -58 -40 -63 0 -5 -15 -27 -34 -50 -18 -23 -41 -56 -49 -73 -9 -18 -30 -46 -47 -62 -16 -17 -30 -35 -30 -40 0 -11 -75 -111 -97 -128 -7 -6 -31 -39 -53 -73 -22 -34 -51 -72 -63 -84 -13 -12 -61 -69 -108 -127 -48 -58 -110 -130 -140 -160 -30 -30 -91 -100 -136 -155 -44 -55 -107 -127 -139 -160 -32 -33 -90 -98 -128 -145 -67 -82 -113 -133 -241 -264 -63 -66 -149 -163 -173 -198 -19 -26 -101 -115 -177 -192 -33 -34 -80 -86 -105 -116 -24 -30 -64 -76 -88 -103 -33 -36 -43 -54 -40 -75 l3 -27 1455 -3 1455 -2 83 87 c46 49 98 111 117 138 18 28 48 67 66 87 46 51 50 56 89 116 18 28 36 52 40 52 3 0 30 36 59 80 29 44 57 80 62 80 5 0 16 15 24 32 24 50 42 80 53 87 13 8 62 79 62 90 0 4 8 15 18 25 11 9 31 41 47 71 15 30 31 55 35 55 4 0 20 25 36 56 15 30 36 60 46 65 10 5 18 20 18 33 0 13 8 30 18 40 11 9 31 41 46 70 15 30 34 57 42 60 8 3 14 13 14 23 0 10 18 45 40 78 22 33 40 65 40 71 0 6 9 19 20 29 11 10 20 26 20 35 0 10 7 23 16 30 8 8 21 27 29 44 19 42 78 148 99 177 9 13 16 31 16 40 0 9 9 24 20 34 11 10 20 28 20 41 0 13 9 28 20 34 11 6 20 21 20 34 0 13 9 31 20 41 11 10 20 26 20 36 0 10 6 24 13 31 7 7 39 65 70 128 32 63 61 122 66 130 39 74 51 101 51 113 0 8 9 26 20 40 11 14 20 32 20 40 0 8 9 26 20 40 11 14 20 34 20 45 0 10 9 27 20 37 11 10 20 28 20 40 0 12 9 30 20 40 11 10 20 31 20 46 0 18 7 32 20 39 13 7 20 21 20 40 0 19 7 33 20 40 12 6 20 21 20 36 0 14 9 37 20 51 11 14 20 38 20 53 0 15 9 37 20 50 11 13 20 33 20 45 0 12 9 30 20 40 11 10 20 31 20 47 0 17 9 41 20 55 11 14 20 35 20 45 0 11 9 31 20 45 11 14 20 38 20 54 0 18 7 32 20 39 14 7 20 21 20 44 0 18 9 45 20 59 11 14 20 36 20 50 0 13 9 32 20 42 12 11 20 31 20 50 0 18 9 44 20 58 11 14 20 36 20 50 0 13 9 32 20 42 11 10 20 31 20 47 0 17 9 41 20 55 11 14 20 38 20 53 0 15 9 35 20 45 11 10 20 31 20 47 0 17 9 41 20 55 11 14 20 38 20 53 0 15 9 35 20 45 11 10 20 30 20 44 0 14 9 40 20 56 11 17 20 42 20 56 0 14 9 34 20 44 12 11 20 31 20 50 0 18 9 44 20 58 11 14 20 39 20 57 0 18 9 43 20 57 11 14 20 38 20 53 0 15 9 35 20 45 12 11 20 31 20 50 0 18 9 44 20 58 11 14 20 36 20 50 0 13 9 34 20 47 11 13 20 36 20 52 0 17 9 41 20 55 11 14 20 38 20 53 0 15 9 35 20 45 12 11 20 31 20 50 0 18 9 42 20 55 11 13 20 37 20 55 0 18 9 44 20 58 11 14 20 40 20 60 0 21 7 41 20 52 12 11 20 31 20 50 0 19 8 39 20 50 12 11 20 31 20 50 0 18 9 44 20 58 11 14 20 37 20 52 0 15 9 38 20 52 11 14 20 40 20 58 0 19 8 39 20 50 12 11 20 31 20 50 0 18 9 44 20 58 11 14 20 38 20 54 0 16 9 36 20 46 13 11 20 29 20 51 0 18 9 45 20 59 11 14 20 40 20 60 0 20 8 44 20 57 11 13 20 37 20 55 0 18 9 44 20 58 11 14 20 38 20 54 0 15 9 42 20 58 11 17 20 42 20 56 0 15 9 38 20 52 11 14 20 38 20 55 0 16 9 41 20 55 11 14 20 38 20 55 0 16 9 41 20 55 11 14 20 39 20 57 0 18 9 43 20 57 11 14 20 39 20 55 0 17 9 41 20 55 12 15 20 41 20 63 0 22 8 48 20 63 11 14 20 37 20 52 0 15 9 38 20 52 11 14 20 40 20 58 0 18 9 44 20 58 11 14 20 38 20 55 0 16 9 41 20 55 11 14 20 40 20 60 0 19 9 45 20 60 11 14 20 38 20 54 0 15 9 42 20 58 11 17 20 44 20 61 0 18 8 38 20 49 13 12 20 31 20 55 0 24 7 43 20 55 13 12 20 31 20 55 0 22 8 48 20 63 11 14 20 39 20 57 0 18 9 43 20 57 11 15 20 41 20 60 0 20 9 46 20 60 11 15 20 41 20 60 0 20 9 46 20 60 11 14 20 40 20 58 0 18 9 44 20 58 11 14 20 38 20 54 0 15 9 39 20 53 11 14 20 39 20 55 0 17 9 44 20 60 11 17 20 41 20 55 0 14 9 39 20 55 11 17 20 44 20 61 0 17 9 42 19 56 11 13 21 37 23 53 l3 30 3113 3 3113 2 9 26 c6 14 26 50 45 79 19 28 35 59 35 68 0 9 9 21 20 27 11 6 20 21 20 34 0 13 9 31 20 41 11 10 20 26 20 36 0 10 6 24 14 32 8 7 28 40 45 73 18 32 39 62 47 67 7 4 14 18 14 29 0 12 7 30 17 40 18 21 36 49 57 94 8 17 22 36 30 44 9 7 16 20 16 30 0 9 9 25 20 35 11 10 20 26 20 36 0 10 6 24 14 32 8 7 28 40 45 73 18 32 39 62 47 67 7 4 14 18 14 29 0 12 7 29 15 38 8 8 28 42 46 75 17 32 37 65 45 72 8 8 14 23 14 33 0 11 9 24 20 30 11 6 20 21 20 34 0 13 9 31 20 41 11 10 20 25 20 34 0 9 18 43 40 76 22 33 40 65 40 72 0 7 9 17 20 23 11 6 20 21 20 34 0 13 6 29 14 35 8 7 26 36 42 66 15 30 35 62 46 71 10 10 18 27 18 40 0 13 9 28 20 34 11 6 20 21 20 34 0 13 9 31 20 41 11 10 20 22 20 27 0 6 9 21 20 35 22 29 27 78 8 90 -7 4 -1496 7 -3309 5 -2944 -2 -3298 0 -3309 13 -11 13 -9 20 9 38 11 13 21 36 21 53 0 16 9 43 20 59 11 17 20 44 20 61 0 17 9 43 20 57 11 14 20 38 20 55 0 16 9 41 20 55 11 14 20 33 20 44 0 10 9 38 20 62 11 24 20 53 20 65 0 11 9 35 20 51 11 17 20 42 20 56 0 15 9 38 20 52 11 14 20 38 20 55 0 16 9 41 20 55 11 14 20 36 20 49 0 12 9 37 20 53 11 17 20 41 20 55 0 14 9 39 20 55 11 17 20 41 20 55 0 14 9 39 20 55 11 17 20 44 20 61 0 17 9 43 20 57 11 14 20 36 20 49 0 13 9 40 20 61 11 20 20 46 20 57 0 12 9 38 20 60 11 22 20 47 20 57 0 10 9 32 20 48 11 17 20 44 20 61 0 17 8 42 18 55 11 13 22 41 25 63 3 21 13 46 22 56 8 9 15 27 15 41 0 13 9 38 20 54 11 17 20 39 20 50 0 11 7 31 17 44 9 13 20 44 25 69 4 25 15 53 23 62 8 9 15 28 15 41 0 13 9 41 20 62 11 20 20 47 20 60 0 12 9 39 20 60 11 20 20 46 20 57 0 12 9 38 20 60 11 22 20 47 20 57 0 10 9 35 20 56 11 20 20 45 20 55 0 10 7 28 17 41 9 13 20 44 25 69 4 25 15 53 23 62 8 9 15 25 15 36 0 10 9 39 20 63 11 24 20 50 20 58 0 9 8 34 19 57 32 70 63 180 60 206 l-4 25 -1151 3 c-633 1 -1154 -1 -1157 -5z M19973 15587 c-2 -4 415 -7 927 -7 512 0 937 -3 943 -6 9 -5 9 -4 0 6 -13 14 -1861 22 -1870 7z M16205 13017 c-13 -20 -15 -494 -15 -4185 l-1 -4162 -20 -35 c-12 -19 -24 -35 -28 -35 -8 0 -61 -77 -61 -89 0 -4 -27 -36 -61 -70 -33 -35 -70 -77 -82 -94 -39 -57 -112 -147 -119 -147 -3 0 -20 -24 -37 -52 -16 -29 -51 -75 -76 -103 -26 -27 -62 -72 -80 -100 -19 -27 -49 -66 -67 -85 -48 -51 -128 -151 -128 -160 0 -4 -25 -33 -55 -64 -30 -30 -55 -58 -55 -60 0 -12 -62 -95 -105 -141 -25 -27 -58 -70 -72 -95 -15 -25 -45 -64 -67 -87 -50 -50 -60 -62 -76 -93 -17 -31 -27 -43 -77 -95 -24 -24 -43 -46 -43 -49 0 -11 -60 -93 -100 -136 -23 -25 -57 -67 -75 -95 -19 -27 -55 -72 -80 -100 -26 -27 -54 -63 -62 -79 -19 -36 -28 -47 -80 -101 -24 -24 -43 -46 -43 -49 0 -12 -62 -95 -109 -146 -28 -30 -51 -58 -51 -62 0 -14 -46 -74 -93 -122 -27 -27 -57 -66 -67 -86 -10 -20 -40 -59 -67 -86 -26 -27 -67 -78 -91 -114 -25 -36 -62 -81 -83 -101 -21 -20 -39 -39 -39 -42 0 -14 -64 -99 -108 -144 -26 -26 -65 -76 -88 -110 -23 -34 -61 -81 -83 -104 -23 -24 -41 -46 -41 -51 0 -13 -45 -73 -86 -114 -22 -22 -58 -67 -79 -100 -22 -32 -55 -74 -73 -92 -36 -34 -82 -97 -82 -111 0 -4 -27 -36 -60 -69 -33 -34 -60 -64 -60 -68 0 -11 -59 -91 -105 -139 -25 -27 -52 -64 -59 -80 -7 -17 -27 -44 -43 -60 -36 -36 -56 -72 -48 -85 4 -7 502 -10 1403 -10 l1397 0 27 33 c16 17 56 68 90 112 34 44 71 90 82 102 31 32 42 47 60 81 9 17 37 53 64 79 26 26 61 68 77 93 37 56 42 62 84 108 18 20 48 60 67 87 18 28 58 77 88 110 31 33 56 64 56 68 0 12 51 78 88 113 17 17 32 36 32 42 0 12 70 102 117 151 18 19 49 57 67 85 19 28 53 71 76 96 23 25 50 62 61 82 10 20 41 59 69 87 27 28 50 52 50 55 0 13 67 103 109 144 25 26 63 73 84 104 21 31 54 74 73 95 20 21 51 61 70 89 18 28 57 75 86 105 53 54 66 71 90 119 7 14 29 41 49 60 20 19 56 64 80 100 25 36 68 90 98 119 30 30 65 75 79 100 13 25 41 62 61 81 20 19 55 62 76 95 22 33 58 78 80 100 22 22 58 67 80 100 22 33 58 78 80 100 22 22 58 67 79 99 22 33 58 78 80 100 41 41 86 101 86 114 0 5 18 26 40 47 l40 39 0 4571 0 4572 -23 21 -23 22 -1067 0 -1067 0 -15 -23z M4594 4080 c-12 -5 -53 -46 -92 -92 -79 -95 -689 -703 -801 -799 -41 -35 -140 -129 -221 -209 -173 -171 -227 -221 -340 -315 -46 -38 -123 -108 -170 -154 -47 -45 -125 -116 -175 -156 -49 -40 -128 -109 -175 -155 -80 -78 -139 -129 -204 -175 -16 -11 -65 -55 -110 -98 -44 -43 -104 -93 -132 -112 -29 -19 -77 -59 -108 -89 -60 -59 -190 -166 -202 -166 -4 0 -23 -17 -43 -38 -20 -20 -56 -51 -81 -67 -60 -40 -62 -42 -127 -103 -30 -29 -78 -68 -107 -87 -28 -18 -70 -51 -92 -72 -23 -21 -52 -45 -64 -53 -13 -8 -35 -25 -50 -38 -15 -12 -31 -22 -34 -22 -4 0 -29 -22 -56 -49 -43 -43 -132 -111 -146 -111 -3 0 -19 -13 -35 -30 -17 -16 -54 -45 -82 -64 -29 -19 -79 -60 -112 -90 -33 -31 -65 -56 -71 -56 -6 0 -19 -9 -29 -20 -10 -11 -22 -20 -27 -20 -5 0 -28 -18 -50 -40 -23 -22 -47 -40 -53 -40 -7 0 -20 -9 -30 -20 -10 -11 -23 -20 -28 -20 -6 0 -26 -17 -46 -39 -20 -21 -46 -41 -57 -45 -30 -9 -58 -42 -51 -61 10 -23 147 -20 220 5 31 11 82 20 115 20 32 0 83 9 115 20 31 11 77 20 102 20 26 0 61 8 82 20 24 12 57 20 88 20 30 0 60 6 73 16 13 9 51 18 85 21 34 4 78 14 97 24 19 11 52 19 72 19 21 0 55 9 75 20 21 11 54 20 73 20 19 0 49 9 65 20 17 11 45 20 63 20 17 0 49 9 69 20 21 11 54 20 73 20 19 0 49 9 65 20 17 11 45 20 63 20 19 0 45 9 59 20 15 12 41 20 63 20 23 0 46 8 60 20 14 12 37 20 60 20 22 0 48 8 63 20 14 11 39 20 57 20 18 0 43 9 57 20 14 11 40 20 58 20 18 0 42 9 55 20 13 11 35 20 49 20 14 0 40 9 56 20 17 11 41 20 53 20 13 0 35 9 49 20 14 11 40 20 58 20 18 0 42 9 55 20 13 11 34 20 47 20 14 0 36 9 50 20 14 11 38 20 53 20 15 0 35 9 45 20 10 11 30 20 45 20 15 0 37 9 50 20 13 11 34 20 47 20 14 0 36 9 50 20 14 11 38 20 53 20 15 0 35 9 45 20 10 11 27 20 37 20 11 0 31 9 45 20 14 11 35 20 45 20 11 0 31 9 45 20 14 11 33 20 43 20 10 0 29 9 43 20 14 11 34 20 45 20 10 0 31 9 45 20 14 11 37 20 51 20 15 0 30 8 36 20 7 13 21 20 39 20 15 0 36 9 46 20 10 11 28 20 40 20 12 0 30 9 40 20 10 11 28 20 40 20 12 0 30 9 40 20 10 11 28 20 40 20 12 0 30 9 40 20 10 11 28 20 40 20 12 0 30 9 40 20 10 11 28 20 41 20 13 0 28 9 34 20 7 13 21 20 40 20 19 0 33 7 40 20 6 11 21 20 34 20 13 0 31 9 41 20 10 11 28 20 40 20 13 0 28 7 35 16 8 8 27 22 44 29 17 8 39 19 49 25 9 5 25 15 35 20 9 6 31 17 48 25 17 7 36 21 44 29 7 9 22 16 35 16 12 0 30 9 40 20 10 11 26 20 36 20 10 0 20 4 24 9 9 16 95 71 110 71 8 0 19 9 25 20 6 11 20 20 32 20 12 0 30 7 40 17 21 18 49 36 94 57 17 8 36 22 44 30 7 9 18 16 25 16 7 0 36 18 64 40 28 22 59 40 70 40 11 0 24 7 29 16 9 16 34 33 90 59 17 8 32 20 32 25 0 5 15 17 33 25 60 29 87 46 87 55 0 6 15 17 33 25 60 29 87 46 87 55 0 6 15 17 33 25 49 24 79 42 86 53 9 15 80 62 92 62 5 0 29 18 51 40 23 22 48 40 56 40 8 0 35 17 61 38 58 46 108 82 117 82 3 0 24 18 45 40 22 22 43 40 47 40 5 0 17 9 27 20 10 11 23 20 29 20 6 0 32 19 57 43 26 23 57 49 69 57 13 8 35 25 50 38 15 12 31 22 34 22 4 0 23 16 44 36 20 19 49 45 65 57 90 69 148 117 187 156 25 24 78 68 117 98 40 29 110 91 157 136 46 45 159 154 250 242 122 117 166 165 164 180 l-3 20 -1470 2 c-828 1 -1479 -2 -1491 -7z"/><path fill="#ce5e32" d="M20885 15580 c-511 -3 -936 -9 -944 -14 -7 -5 -19 -23 -27 -40 -21 -45 -37 -69 -56 -84 -10 -7 -18 -21 -18 -30 0 -9 -18 -42 -40 -73 -22 -32 -40 -61 -40 -67 0 -5 -9 -17 -20 -27 -11 -10 -20 -26 -20 -35 0 -10 -9 -29 -20 -42 -11 -14 -24 -36 -30 -49 -6 -13 -21 -42 -35 -64 -14 -22 -29 -50 -35 -62 -5 -11 -13 -24 -18 -27 -6 -3 -26 -39 -46 -78 -20 -40 -48 -91 -61 -113 -14 -22 -29 -50 -35 -62 -5 -11 -13 -24 -18 -27 -5 -3 -26 -38 -47 -78 -51 -101 -59 -115 -78 -136 -10 -10 -17 -25 -17 -32 0 -7 -7 -21 -16 -31 -18 -20 -45 -67 -69 -121 -10 -21 -21 -38 -26 -38 -5 0 -9 -6 -9 -14 0 -7 -6 -19 -13 -25 -8 -6 -29 -41 -47 -78 -19 -38 -39 -75 -46 -83 -6 -8 -24 -39 -39 -68 -15 -29 -31 -55 -36 -58 -5 -3 -16 -20 -24 -37 -8 -18 -26 -50 -40 -72 -14 -22 -32 -55 -41 -72 -9 -18 -20 -33 -24 -33 -4 0 -11 -12 -14 -26 -4 -15 -14 -33 -21 -41 -24 -23 -19 -70 8 -77 12 -3 489 -6 1060 -6 l1037 0 25 16 c14 9 25 22 25 29 0 8 6 20 13 27 8 7 17 25 20 40 4 15 13 33 20 40 7 7 18 32 25 56 7 23 17 42 22 42 6 0 10 8 10 17 0 17 8 37 87 203 25 52 50 109 57 125 12 30 42 95 76 170 10 22 22 51 25 65 4 14 13 32 20 40 7 8 18 32 25 53 6 20 15 37 19 37 4 0 12 20 19 45 7 25 16 45 22 45 5 0 10 7 10 15 0 8 18 49 39 92 22 43 49 101 61 128 41 96 88 202 119 268 11 23 23 54 27 69 3 15 12 32 20 39 8 6 14 17 14 23 0 7 20 52 45 100 25 49 45 93 45 98 0 6 9 21 20 35 25 32 27 89 3 100 -10 4 -436 6 -948 3z"/></g></svg>
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
    title: "Hyakki",
    directory: "t3code",
    repositoryUrl: "https://github.com/neur0map/hyakki.git",
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
      "Give Hyakki a remote-first command center. Make three machines feel one tap away, keep agent work in sync, and make every handoff feel instant.",
    response:
      "Hyakki now treats every machine like it is right here in the room. ✦\n\n- Moonbase, Suspense Station, and Kernel Cabin stay live together\n- Terminal state follows you without losing a single line\n- Agent work remains perfectly in sync across devices\n- Handoffs land before your train of thought can wander\n\nI also ran the changed workspace: **612 tests passed**.",
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
    repositoryUrl: "https://github.com/neur0map/hyakki.git",
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
    `# ${input.title}\n\nSeeded by the Hyakki mobile screenshot harness.\n`,
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
