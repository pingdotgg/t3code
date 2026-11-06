// @effect-diagnostics nodeBuiltinImport:off -- fixtures write a native session database.
import * as NodeSqlite from "node:sqlite";
import * as NodeURL from "node:url";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

export const ROOT = "7d40e54d-5977-4239-940b-246cdd81a12b";
export const CHILD = "a357bf2720914589dd1ec49f7a816115";
export const LAUNCH = { role: "Readme Reader", prompt: "Read README.md and report the marker" };

// Mirrors the 1.4.5 runtime: Step{5: metadata{4: tool call{1 id, 2 name}}, 20: planner{7: calls},
// 143: invoke_subagent{9: specs{2 role, 3 prompt}, 10: results{1 conversation, 2 log uri}}}.
const varint = (value: number): number[] => {
  const bytes: number[] = [];
  while (value >= 0x80) {
    bytes.push((value & 0x7f) | 0x80);
    value = Math.floor(value / 0x80);
  }
  return [...bytes, value];
};
const field = (number: number, value: string | Uint8Array) => {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  return [...varint(number * 8 + 2), ...varint(bytes.length), ...bytes];
};
const proto = (...parts: number[][]) => Uint8Array.from(parts.flat());
const toolCall = (id: string) => proto(field(1, id), field(2, "invoke_subagent"));

export const invokeStep = (input: {
  readonly callId: string;
  readonly launches: ReadonlyArray<typeof LAUNCH>;
  readonly children: ReadonlyArray<{ readonly id: string; readonly logUri: string }>;
}) =>
  proto(
    [...varint(1 * 8), ...varint(127)],
    field(5, proto(field(4, toolCall(input.callId)))),
    field(
      143,
      proto(
        ...input.launches.map((launch) =>
          field(9, proto(field(1, "research"), field(2, launch.role), field(3, launch.prompt))),
        ),
        ...input.children.map((child) =>
          field(10, proto(field(1, child.id), field(2, child.logUri))),
        ),
      ),
    ),
  );
export const plannerStep = (callIds: ReadonlyArray<string>) =>
  proto(field(20, proto(...callIds.map((id) => field(7, toolCall(id))))));

export const transcriptLines = [
  // Trimmed from 1.4.5: the launch envelope around the prompt the parent record already holds.
  {
    step_index: 0,
    type: "SYSTEM_MESSAGE",
    status: "DONE",
    content: `<USER_REQUEST sender="7d40e54d-5977-4239-940b-246cdd81a12b" timestamp="2026-10-31T18:00:00Z">\n${LAUNCH.prompt}\n</USER_REQUEST>`,
  },
  {
    step_index: 1,
    type: "PLANNER_RESPONSE",
    status: "DONE",
    // The runtime stores each argument value as JSON text.
    tool_calls: [{ name: "view_file", args: { AbsolutePath: '"/project/README.md"' } }],
  },
  { step_index: 2, type: "VIEW_FILE", status: "DONE", content: "2: child read marker 4242" },
  { step_index: 3, type: "PLANNER_RESPONSE", status: "DONE", content: "marker 4242 found" },
];

export const makeProfile = Effect.fn("makeProfile")(function* (input: {
  /** Defaults to a scoped temp directory. */
  readonly profile?: string;
  readonly steps: (logUri: string) => ReadonlyArray<readonly [number, number, Uint8Array]>;
  readonly transcript?: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const profile = input.profile ?? (yield* fs.makeTempDirectoryScoped({ prefix: "t3-agy-child-" }));
  const acp = path.join(profile, "antigravity-acp");
  const logs = path.join(acp, "brain", CHILD, ".system_generated", "logs");
  yield* fs.makeDirectory(path.join(acp, "conversations"), { recursive: true });
  yield* fs.makeDirectory(logs, { recursive: true });
  const transcriptPath = path.join(logs, "transcript.jsonl");
  yield* fs.writeFileString(
    transcriptPath,
    input.transcript ?? transcriptLines.map((line) => JSON.stringify(line)).join("\n") + "\n",
  );
  const logUri = NodeURL.pathToFileURL(transcriptPath).href;
  const database = new NodeSqlite.DatabaseSync(path.join(acp, "conversations", `${ROOT}.db`));
  database.exec(
    "CREATE TABLE steps (idx integer PRIMARY KEY, step_type integer NOT NULL DEFAULT 0, step_format integer NOT NULL DEFAULT 0, step_payload blob)",
  );
  const insert = database.prepare(
    "INSERT INTO steps (idx, step_type, step_payload) VALUES (?, ?, ?)",
  );
  for (const [idx, type, payload] of input.steps(logUri)) insert.run(idx, type, payload);
  database.close();
  return { profile, transcriptPath, logUri };
});

export const autoApproved = (logUri: string) =>
  [
    [1, 15, plannerStep(["call-a"])],
    [
      2,
      127,
      invokeStep({ callId: "call-a", launches: [LAUNCH], children: [{ id: CHILD, logUri }] }),
    ],
  ] as const;
