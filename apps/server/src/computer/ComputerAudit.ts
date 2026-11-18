// Ported from LocalRouter (github.com/jayleaton/localrouter @fe24726, apps/companion/src/executor/audit.ts and
// src/computer/audit.zig), Apache-2.0, Copyright 2026 Jay Leaton. Modified for Ada.
// A typed digest is cheap and the line is written on the same tick as the step.
// @effect-diagnostics nodeBuiltinImport:off
import type { ComputerAction, ComputerApprovalBinding } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as NodeCrypto from "node:crypto";

import * as ServerConfig from "../config.ts";

/**
 * One JSON object a line for every task, grant, approval, action, refusal and outcome, in
 * `<T3 home>/userdata/computer/audit.jsonl`. The person's screen text stays out of it: typed text is its length
 * and a SHA-256 prefix, and labels and titles are clipped to 80 bytes. The file keeps its newest half past
 * 8 MiB. Best effort: a full disk loses lines, never a task.
 */

/** The two events that record a consequential step. They carry the same fields: see `approvalAuditFields`. */
export const APPROVAL_REQUEST_AUDIT_EVENT = "approval.request";
export const APPROVAL_SKIPPED_AUDIT_EVENT = "approval_skipped";
export type ApprovalAuditEvent =
  | typeof APPROVAL_REQUEST_AUDIT_EVENT
  | typeof APPROVAL_SKIPPED_AUDIT_EVENT;

const CLIP_BYTES = 80;
const MAX_AUDIT_BYTES = 8 << 20;

const utf8 = (value: string) => new TextEncoder().encode(value);
const encodeJson = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const decodeJsonLine = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

export interface TextDigest {
  /** UTF-8 bytes, as the length of what was typed. */
  readonly len: number;
  /** The first 12 hex digits of its SHA-256. */
  readonly sha256: string;
}

/** Typed text as the log keeps it: its length and a digest, never the text itself. */
export const textDigest = (text: string): TextDigest => ({
  len: utf8(text).byteLength,
  sha256: NodeCrypto.createHash("sha256").update(text, "utf8").digest("hex").slice(0, 12),
});

/** `value` cut to 80 UTF-8 bytes, never inside a character. */
export const clip = (value: string): string => {
  if (utf8(value).byteLength <= CLIP_BYTES) return value;
  const characters = Array.from(value);
  let bytes = 0;
  let end = 0;
  for (const character of characters) {
    bytes += utf8(character).byteLength;
    if (bytes > CLIP_BYTES) break;
    end += 1;
  }
  return characters.slice(0, end).join("");
};

/** A step's action for the log: typed text as its digest, screen text clipped. */
const actionAuditFields = (action: ComputerAction): Readonly<Record<string, unknown>> => ({
  kind: action.kind,
  ...(action.ref ? { ref: action.ref } : {}),
  ...(action.role ? { role: action.role } : {}),
  ...(action.label ? { label: clip(action.label) } : {}),
  ...(action.text ? { text: textDigest(action.text) } : {}),
  ...(action.key ? { key: action.key } : {}),
  ...(action.fieldRole ? { fieldRole: action.fieldRole } : {}),
  ...(action.fieldLabel ? { fieldLabel: clip(action.fieldLabel) } : {}),
  ...(action.direction ? { direction: action.direction } : {}),
  ...(action.what ? { what: action.what } : {}),
  ...(action.name ? { name: clip(action.name) } : {}),
});

/** The fields an approval's audit line carries, whether it waited for a tap or ran with approvals off. */
export const approvalAuditFields = (
  binding: ComputerApprovalBinding,
): Readonly<Record<string, unknown>> => ({
  hostId: binding.hostId,
  taskId: binding.taskId,
  step: binding.step,
  app: clip(binding.app),
  title: clip(binding.title),
  url: clip(binding.url),
  action: actionAuditFields(binding.action),
  why: binding.why,
  goal: clip(binding.goal),
  requester: binding.requester,
});

const parseLines = (data: string): ReadonlyArray<Readonly<Record<string, unknown>>> =>
  data.split("\n").flatMap((line) => {
    if (!line) return [];
    // A line torn by rotation is skipped, never a reason to lose the rest.
    const value = Option.getOrUndefined(decodeJsonLine(line));
    return typeof value === "object" && value !== null ? [value as Record<string, unknown>] : [];
  });

export class ComputerAudit extends Context.Service<
  ComputerAudit,
  {
    readonly record: (
      event: string,
      fields?: Readonly<Record<string, unknown>>,
    ) => Effect.Effect<void>;
    /** The newest `limit` lines, oldest first. */
    readonly tail: (
      limit: number,
    ) => Effect.Effect<ReadonlyArray<Readonly<Record<string, unknown>>>>;
  }
>()("t3/computer/ComputerAudit") {}

export const make = Effect.fn("computer.audit.make")(function* (path: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;
  const semaphore = yield* Semaphore.make(1);

  /** Past 8 MiB: the file keeps its newest half (whole lines), then the new line. */
  const rotate = Effect.fnUntraced(function* (line: Uint8Array) {
    const data = yield* fileSystem.readFile(path);
    const kept = data.subarray(Math.floor(data.length / 2));
    const newline = kept.indexOf(0x0a);
    const rest = newline === -1 ? kept : kept.subarray(newline + 1);
    const next = new Uint8Array(rest.length + line.length);
    next.set(rest, 0);
    next.set(line, rest.length);
    yield* fileSystem.writeFile(path, next, { mode: 0o600 });
  });

  const append = Effect.fnUntraced(function* (line: string) {
    yield* fileSystem.makeDirectory(paths.dirname(path), { recursive: true, mode: 0o700 });
    const exists = yield* fileSystem.exists(path);
    const size = exists ? Number((yield* fileSystem.stat(path)).size) : 0;
    if (size > MAX_AUDIT_BYTES) return yield* rotate(utf8(line));
    yield* fileSystem.writeFileString(path, line, { flag: "a", mode: 0o600 });
  });

  const record: ComputerAudit["Service"]["record"] = (event, fields = {}) =>
    semaphore.withPermits(1)(
      Effect.gen(function* () {
        const ts = yield* Clock.currentTimeMillis;
        const line = yield* encodeJson({ ts, event, ...fields });
        yield* append(`${line}\n`);
      }).pipe(
        Effect.catch((cause) => Effect.logWarning("Computer audit lost a line", { event, cause })),
      ),
    );

  const tail: ComputerAudit["Service"]["tail"] = (limit) =>
    semaphore.withPermits(1)(
      Effect.gen(function* () {
        if (limit <= 0) return [];
        const data = yield* fileSystem.readFileString(path).pipe(Effect.orElseSucceed(() => ""));
        return parseLines(data).slice(-limit);
      }),
    );

  return ComputerAudit.of({ record, tail });
});

export const layer = Layer.effect(
  ComputerAudit,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const paths = yield* Path.Path;
    return yield* make(paths.join(config.stateDir, "computer", "audit.jsonl"));
  }),
);
