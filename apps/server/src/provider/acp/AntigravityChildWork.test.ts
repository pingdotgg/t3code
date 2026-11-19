// @effect-diagnostics nodeBuiltinImport:off -- fixtures name transcript files by URL.
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  ANTIGRAVITY_SUBAGENT_BATCH_TITLE,
  antigravitySubagentLaunches,
  describeAntigravitySubagentLaunches,
  makeAntigravityCommandStatusReader,
  readAntigravityChildWork,
} from "./AntigravityChildWork.ts";
import { sanitizeAntigravityToolPayload } from "./AntigravityProtocol.ts";
import {
  autoApproved,
  CHILD,
  invokeStep,
  LAUNCH,
  makeProfile,
  plannerStep,
  ROOT,
  transcriptLines,
} from "./AntigravityChildWork.testkit.ts";

const varint = (value: number): number[] => {
  const bytes: number[] = [];
  let current = value;
  while (current >= 0x80) {
    bytes.push((current & 0x7f) | 0x80);
    current = Math.floor(current / 0x80);
  }
  return [...bytes, current];
};
const field = (num: number, value: string | Uint8Array) => {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  return [...varint(num * 8 + 2), ...varint(bytes.length), ...bytes];
};

const read = (
  profileDirectory: string,
  nativeTaskId: string,
  launch: { readonly title: string | null; readonly prompt: string } = {
    title: null,
    prompt: "Readme check",
  },
  siblings: ReadonlyArray<{
    readonly nativeTaskId: string;
    readonly title: string | null;
    readonly prompt: string;
  }> = [],
) =>
  readAntigravityChildWork({
    profileDirectory,
    rootSessionId: ROOT,
    nativeTaskId,
    launch,
    siblings,
  });

it.layer(NodeServices.layer)("readAntigravityChildWork", (it) => {
  it.effect("follows an auto-approved call id through its planner step to the record", () =>
    Effect.gen(function* () {
      const { profile } = yield* makeProfile({ steps: autoApproved });
      const [child, ...rest] = yield* read(profile, `${ROOT}:1`);
      expect(rest).toEqual([]);
      expect(child).toMatchObject({
        conversationId: CHILD,
        role: LAUNCH.role,
        prompt: LAUNCH.prompt,
        truncated: false,
      });
      // The launch envelope repeats the prompt shown above, so the steps start with the child's work.
      expect(child?.steps?.map((step) => step.text ?? step.toolCalls[0]?.name)).toEqual([
        "view_file",
        "2: child read marker 4242",
        "marker 4242 found",
      ]);
      expect(child?.steps?.[0]?.toolCalls[0]?.input).toBe('{"AbsolutePath":"/project/README.md"}');
    }),
  );

  it.effect("needs proof that the call id belongs to the parent's record", () =>
    Effect.gen(function* () {
      const { profile } = yield* makeProfile({
        steps: (logUri) => [
          ...autoApproved(logUri),
          [5, 15, plannerStep(["call-b", "call-c"])],
          [
            6,
            127,
            invokeStep({ callId: "call-b", launches: [LAUNCH], children: [{ id: CHILD, logUri }] }),
          ],
          [
            7,
            127,
            invokeStep({ callId: "call-c", launches: [LAUNCH], children: [{ id: CHILD, logUri }] }),
          ],
        ],
      });
      // Another session's id, a step that is not the planner call, and parallel calls that share one id.
      expect(yield* read(profile, `00000000-0000-4000-8000-000000000000:1`)).toEqual([]);
      expect(yield* read(profile, `${ROOT}:2`)).toEqual([]);
      expect(yield* read(profile, `${ROOT}:5`)).toEqual([]);
    }),
  );

  it.effect("matches a permission-prompt call by its launch text, only when unique", () =>
    Effect.gen(function* () {
      const other = { role: "Test Runner", prompt: "Run the tests" };
      const long = { role: "Long Reader", prompt: `Read this:\n${"x".repeat(9_000)}` };
      // A role's leading byte order mark is part of its text.
      const marked = { role: "\uFEFFMarked", prompt: "Check the mark" };
      const { profile } = yield* makeProfile({
        steps: (logUri) => [
          [
            2,
            127,
            invokeStep({ callId: "x", launches: [LAUNCH], children: [{ id: CHILD, logUri }] }),
          ],
          [
            8,
            127,
            invokeStep({ callId: "w", launches: [long], children: [{ id: CHILD, logUri }] }),
          ],
          [
            10,
            127,
            invokeStep({ callId: "v", launches: [marked], children: [{ id: CHILD, logUri }] }),
          ],
          [
            4,
            127,
            invokeStep({ callId: "y", launches: [other], children: [{ id: CHILD, logUri }] }),
          ],
          [
            6,
            127,
            invokeStep({ callId: "z", launches: [other], children: [{ id: CHILD, logUri }] }),
          ],
        ],
      });
      const opaque = "35bea692fa95447fbdae6333fec5515f";
      const matched = yield* read(profile, opaque, describeAntigravitySubagentLaunches([LAUNCH]));
      expect(matched.map((child) => child.role)).toEqual([LAUNCH.role]);
      // T3 knows a second batch with this text that the agent has not recorded yet.
      const twin = { nativeTaskId: "f00d", ...describeAntigravitySubagentLaunches([LAUNCH]) };
      expect(
        yield* read(profile, opaque, describeAntigravitySubagentLaunches([LAUNCH]), [twin]),
      ).toEqual([]);
      // T3 stores the launch from the bounded tool payload, which keeps only a long prompt's tail.
      const stored = antigravitySubagentLaunches(
        sanitizeAntigravityToolPayload({ Subagents: [{ Role: long.role, Prompt: long.prompt }] }),
      );
      const longMatch = yield* read(profile, opaque, describeAntigravitySubagentLaunches(stored!));
      expect(longMatch.map((child) => child.prompt)).toEqual([long.prompt]);
      expect(
        yield* read(profile, opaque, describeAntigravitySubagentLaunches([marked])),
      ).toHaveLength(1);
      expect(yield* read(profile, opaque, { title: "Marked", prompt: marked.prompt })).toEqual([]);
      expect(yield* read(profile, opaque, describeAntigravitySubagentLaunches([other]))).toEqual(
        [],
      );
      expect(yield* read(profile, opaque, { title: null, prompt: "Readme check" })).toEqual([]);
    }),
  );

  it.effect("leaves an auto-approved batch's record out of a launch-text match", () =>
    Effect.gen(function* () {
      const { profile } = yield* makeProfile({ steps: autoApproved });
      const launch = describeAntigravitySubagentLaunches([LAUNCH]);
      const opaque = "35bea692fa95447fbdae6333fec5515f";
      expect(yield* read(profile, opaque, launch)).toHaveLength(1);
      // An earlier auto-approved batch stored no launch text, but its planner step claims the record.
      const auto = {
        nativeTaskId: `${ROOT}:1`,
        title: ANTIGRAVITY_SUBAGENT_BATCH_TITLE,
        prompt: "",
      };
      expect(yield* read(profile, opaque, launch, [auto])).toEqual([]);
      // A sibling that cannot be ruled out refuses the match: its planner step is unreadable,
      // or it is a permission batch whose launch text is missing or cut.
      for (const sibling of [
        { ...auto, nativeTaskId: `${ROOT}:99` },
        { nativeTaskId: "0ld", title: ANTIGRAVITY_SUBAGENT_BATCH_TITLE, prompt: "Running" },
        // Its stored launch was cut, so it may be this same launch.
        { nativeTaskId: "cut", title: LAUNCH.role, prompt: "[Earlier output truncated]\n\nmarker" },
        { nativeTaskId: "cut", title: "[Earlier output truncated]\n\nReader", prompt: "x" },
        { nativeTaskId: "cut", title: null, prompt: "[Earlier output truncated]\n\nx" },
      ]) {
        expect(yield* read(profile, opaque, launch, [sibling])).toEqual([]);
      }
      // A cut prompt under different roles is another launch.
      const other = {
        nativeTaskId: "cut",
        title: "Test Runner",
        prompt: "[Earlier output truncated]\n\nx",
      };
      expect(yield* read(profile, opaque, launch, [other])).toHaveLength(1);
    }),
  );

  it.effect("reads no transcript outside the child's own profile path", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const outside = yield* fs.makeTempDirectoryScoped({ prefix: "t3-agy-outside-" });
      const secret = path.join(outside, "transcript.jsonl");
      yield* fs.writeFileString(secret, JSON.stringify(transcriptLines[3]) + "\n");
      const named = yield* makeProfile({
        steps: () => autoApproved(NodeURL.pathToFileURL(secret).href),
      });
      const [namedChild] = yield* read(named.profile, `${ROOT}:1`);
      expect(namedChild?.role).toBe(LAUNCH.role);
      expect(namedChild?.steps).toBeNull();

      const linked = yield* makeProfile({ steps: autoApproved });
      yield* fs.remove(linked.transcriptPath);
      yield* fs.symlink(secret, linked.transcriptPath);
      const [linkedChild] = yield* read(linked.profile, `${ROOT}:1`);
      expect(linkedChild?.steps).toBeNull();
    }),
  );

  it.effect("reads only the tail of a large transcript", () =>
    Effect.gen(function* () {
      const filler = JSON.stringify({
        step_index: 0,
        type: "VIEW_FILE",
        status: "DONE",
        content: "x".repeat(10_000),
      });
      const { profile } = yield* makeProfile({
        steps: autoApproved,
        transcript: `${Array.from({ length: 40 }, () => filler).join("\n")}\n${JSON.stringify(transcriptLines[3])}\n`,
      });
      const [child] = yield* read(profile, `${ROOT}:1`);
      expect(child?.truncated).toBe(true);
      expect(child?.steps?.length).toBeLessThan(40);
      expect(child?.steps?.at(-1)?.text).toBe("marker 4242 found");
      expect(child?.steps?.[0]?.text?.length).toBeLessThanOrEqual(4_001);
    }),
  );

  it.effect("refuses links between children and sessions inside the same profile", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const sibling = "b468c0e1d2f34a5b6c7d8e9f0a1b2c3d";
      // The record names this child's literal path, but the child directory links to a sibling.
      const linked = yield* makeProfile({ steps: autoApproved });
      const brain = path.join(linked.profile, "antigravity-acp", "brain");
      yield* fs.rename(path.join(brain, CHILD), path.join(brain, sibling));
      yield* fs.symlink(path.join(brain, sibling), path.join(brain, CHILD));
      const [child] = yield* read(linked.profile, `${ROOT}:1`);
      expect(child?.role).toBe(LAUNCH.role);
      expect(child?.steps).toBeNull();

      // This session's database links to another session's records.
      const other = yield* makeProfile({ steps: autoApproved });
      const conversations = path.join(other.profile, "antigravity-acp", "conversations");
      const peer = path.join(conversations, "00000000-0000-4000-8000-000000000000.db");
      yield* fs.rename(path.join(conversations, `${ROOT}.db`), peer);
      yield* fs.symlink(peer, path.join(conversations, `${ROOT}.db`));
      expect(yield* read(other.profile, `${ROOT}:1`)).toEqual([]);
    }),
  );

  it.effect("declines a launch-text match it cannot prove unique within its scan bounds", () =>
    Effect.gen(function* () {
      const record = (callId: string, logUri: string) =>
        invokeStep({ callId, launches: [LAUNCH], children: [{ id: CHILD, logUri }] });
      const other = { role: "Test Runner", prompt: "Run the tests" };
      const filler = (idx: number, logUri: string) =>
        [
          idx,
          127,
          invokeStep({ callId: `f${idx}`, launches: [other], children: [{ id: CHILD, logUri }] }),
        ] as const;
      const opaque = "35bea692fa95447fbdae6333fec5515f";
      const launch = describeAntigravitySubagentLaunches([LAUNCH]);
      const cases = [
        // More records than one open may scan.
        (logUri: string) => [
          [1, 127, record("x", logUri)] as const,
          ...Array.from({ length: 200 }, (_, index) => filler(index + 2, logUri)),
        ],
        // An oversized record could hold an identical launch.
        (logUri: string) => [
          [1, 127, record("x", logUri)] as const,
          [2, 127, new Uint8Array(1024 * 1024 + 1)] as const,
        ],
        // So could one this reader cannot decode.
        (logUri: string) => [
          [1, 127, record("x", logUri)] as const,
          [2, 127, Uint8Array.from([0xff, 0xff])] as const,
        ],
      ];
      for (const steps of cases) {
        const { profile } = yield* makeProfile({ steps });
        expect(yield* read(profile, opaque, launch)).toEqual([]);
      }
    }),
  );

  it.effect("keeps the batch view for a batch over the child limit", () =>
    Effect.gen(function* () {
      const { profile } = yield* makeProfile({
        steps: (logUri) => [
          [1, 15, plannerStep(["call-a"])],
          [
            2,
            127,
            invokeStep({
              callId: "call-a",
              launches: Array.from({ length: 17 }, () => LAUNCH),
              children: Array.from({ length: 17 }, () => ({ id: CHILD, logUri })),
            }),
          ],
        ],
      });
      expect(yield* read(profile, `${ROOT}:1`)).toEqual([]);
    }),
  );

  it.effect("shares one transcript budget across the batch", () =>
    Effect.gen(function* () {
      const filler = JSON.stringify({
        step_index: 0,
        type: "VIEW_FILE",
        status: "DONE",
        content: "x".repeat(1_000),
      });
      const transcript = `${Array.from({ length: 300 }, () => filler).join("\n")}\n`;
      const { profile } = yield* makeProfile({
        transcript,
        steps: (logUri) => [
          [1, 15, plannerStep(["call-a"])],
          [
            2,
            127,
            invokeStep({
              callId: "call-a",
              launches: Array.from({ length: 16 }, () => LAUNCH),
              children: Array.from({ length: 16 }, () => ({ id: CHILD, logUri })),
            }),
          ],
        ],
      });
      const children = yield* read(profile, `${ROOT}:1`);
      expect(children).toHaveLength(16);
      expect(children.every((child) => child.truncated)).toBe(true);
      expect(JSON.stringify(children).length).toBeLessThan(600 * 1024);
    }),
  );

  it.effect("reads native command steps.status values and tracks cached transitions", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const profile = yield* fs.makeTempDirectoryScoped({ prefix: "t3-agy-cmd-status-" });
      const conversations = path.join(profile, "antigravity-acp", "conversations");
      yield* fs.makeDirectory(conversations, { recursive: true });
      const dbPath = path.join(conversations, `${ROOT}.db`);
      const metadataFor = (callId: string) =>
        Uint8Array.from(
          field(4, Uint8Array.from([...field(1, callId), ...field(2, "run_command")])),
        );
      const { DatabaseSync } = yield* Effect.promise(() => import("node:sqlite"));
      const db = new DatabaseSync(dbPath);
      try {
        db.exec(
          "CREATE TABLE steps (idx integer PRIMARY KEY, step_type integer NOT NULL DEFAULT 0, status integer NOT NULL DEFAULT 0, metadata blob, step_payload blob, step_format integer NOT NULL DEFAULT 0)",
        );
        const insert = db.prepare(
          "INSERT INTO steps (idx, step_type, status, metadata, step_payload, step_format) VALUES (?, ?, ?, ?, ?, 0)",
        );
        const plannerPayload = Uint8Array.from(
          field(
            20,
            Uint8Array.from(
              field(
                7,
                Uint8Array.from([...field(1, "call_via_planner"), ...field(2, "run_command")]),
              ),
            ),
          ),
        );
        insert.run(9, 15, 3, new Uint8Array(), plannerPayload);
        insert.run(10, 132, 2, metadataFor("call_run"), new Uint8Array());
        insert.run(11, 132, 6, metadataFor("call_cancel"), new Uint8Array());
        insert.run(12, 132, 7, metadataFor("call_err"), new Uint8Array());
        insert.run(13, 21, 5, metadataFor("call_cleared"), new Uint8Array());
        insert.run(14, 132, 99, metadataFor("call_unknown"), new Uint8Array());
        insert.run(15, 21, 2, metadataFor("call_via_planner"), new Uint8Array());
      } finally {
        db.close();
      }
      const readStatuses = makeAntigravityCommandStatusReader(profile, ROOT);
      const initial = yield* readStatuses([
        { toolCallId: "call_run" },
        { toolCallId: "call_cancel" },
        { toolCallId: "call_err" },
        { toolCallId: "call_cleared" },
        { toolCallId: "call_unknown" },
        { toolCallId: `${ROOT}:9` },
        { toolCallId: "call_missing" },
      ]);
      expect(initial.get("call_run")).toBe("running");
      expect(initial.get("call_cancel")).toBe("cancelled");
      expect(initial.get("call_err")).toBe("failed");
      expect(initial.get("call_cleared")).toBe("cancelled");
      expect(initial.get("call_unknown")).toBeUndefined();
      expect(initial.get(`${ROOT}:9`)).toBe("running");
      expect(initial.get("call_missing")).toBeUndefined();

      const updateDb = new DatabaseSync(dbPath);
      try {
        updateDb.prepare("UPDATE steps SET status = 3 WHERE idx = 10").run();
        updateDb
          .prepare(
            "INSERT INTO steps (idx, step_type, status, metadata, step_payload, step_format) VALUES (16, 132, 3, ?, ?, 0)",
          )
          .run(metadataFor("call_late_insert"), new Uint8Array());
      } finally {
        updateDb.close();
      }
      const next = yield* readStatuses([
        { toolCallId: "call_run" },
        { toolCallId: "call_late_insert" },
      ]);
      expect(next.get("call_run")).toBe("completed");
      expect(next.get("call_late_insert")).toBe("completed");
    }),
  );

  it.effect("reads native command statuses from step_payload when metadata column is absent", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const profile = yield* fs.makeTempDirectoryScoped({ prefix: "t3-agy-cmd-nometa-" });
      const conversations = path.join(profile, "antigravity-acp", "conversations");
      yield* fs.makeDirectory(conversations, { recursive: true });
      const dbPath = path.join(conversations, `${ROOT}.db`);
      const stepPayloadFor = (callId: string) =>
        Uint8Array.from(
          field(
            5,
            Uint8Array.from(
              field(4, Uint8Array.from([...field(1, callId), ...field(2, "run_command")])),
            ),
          ),
        );
      const { DatabaseSync } = yield* Effect.promise(() => import("node:sqlite"));
      const db = new DatabaseSync(dbPath);
      try {
        db.exec(
          "CREATE TABLE steps (idx integer PRIMARY KEY, step_type integer NOT NULL DEFAULT 0, status integer NOT NULL DEFAULT 0, step_payload blob, step_format integer NOT NULL DEFAULT 0)",
        );
        db.prepare(
          "INSERT INTO steps (idx, step_type, status, step_payload, step_format) VALUES (20, 132, 3, ?, 0)",
        ).run(stepPayloadFor("call_nometa"));
      } finally {
        db.close();
      }
      const readStatuses = makeAntigravityCommandStatusReader(profile, ROOT);
      const statuses = yield* readStatuses([{ toolCallId: "call_nometa" }]);
      expect(statuses.get("call_nometa")).toBe("completed");
    }),
  );
});
