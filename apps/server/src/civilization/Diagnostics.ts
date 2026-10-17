import type {
  CivilizationConfig,
  CivilizationMessageId,
  ProjectId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

const DIAGNOSTIC_WINDOW_MS = 60_000;
const DIAGNOSTIC_PRUNE_AGE_MS = DIAGNOSTIC_WINDOW_MS * 10;

type DiagnosticWindow = {
  readonly lastEmittedAtMs: number;
  readonly suppressed: number;
};

export type CivilizationDiagnosticSeverity = "error" | "normal";

/**
 * Deliberately narrow diagnostic fields. Feature logs may contain operational
 * identifiers, revisions, timing/size counters and rejection codes, but never
 * message/note bodies, prompts, credentials, provider payloads or secrets.
 */
export type CivilizationDiagnosticFields = {
  readonly threadId?: ThreadId;
  readonly runId?: RunId;
  readonly messageId?: CivilizationMessageId;
  readonly environmentRevision?: number;
  readonly projectRevision?: number;
  readonly citizenRevision?: number;
  readonly durationMs?: number;
  readonly bytes?: number;
  readonly count?: number;
  readonly rejectionCode?: string;
};

export type CivilizationDiagnosticInput = {
  readonly projectId: ProjectId;
  readonly event: string;
  readonly severity: CivilizationDiagnosticSeverity;
  readonly fields?: CivilizationDiagnosticFields;
};

type EffectiveConfig = {
  readonly config: CivilizationConfig;
};

type DiagnosticDecision = {
  readonly emit: boolean;
  readonly suppressed: number;
};

export const makeCivilizationDiagnostics = Effect.fn("CivilizationDiagnostics.make")(function* (
  getEffective: (projectId: ProjectId) => Effect.Effect<EffectiveConfig | undefined, never>,
) {
  const windows = yield* Ref.make<ReadonlyMap<string, DiagnosticWindow>>(new Map());

  const emit = Effect.fn("CivilizationDiagnostics.emit")(function* (
    input: CivilizationDiagnosticInput,
  ) {
    const effective = yield* getEffective(input.projectId);
    if (effective === undefined) return;
    const mode = effective.config.operations.diagnostics;
    if (mode === "off" || (mode === "errors" && input.severity !== "error")) return;

    const nowMs = yield* Clock.currentTimeMillis;
    const key = `${input.projectId}\u0000${input.severity}\u0000${input.event}`;
    const decision = yield* Ref.modify(
      windows,
      (current): readonly [DiagnosticDecision, ReadonlyMap<string, DiagnosticWindow>] => {
        const previous = current.get(key);
        if (previous !== undefined && nowMs - previous.lastEmittedAtMs < DIAGNOSTIC_WINDOW_MS) {
          const next = new Map(current);
          next.set(key, { ...previous, suppressed: previous.suppressed + 1 });
          return [{ emit: false, suppressed: 0 }, next] as const;
        }

        const next = new Map(
          [...current].filter(
            ([, value]) => nowMs - value.lastEmittedAtMs < DIAGNOSTIC_PRUNE_AGE_MS,
          ),
        );
        next.set(key, { lastEmittedAtMs: nowMs, suppressed: 0 });
        return [{ emit: true, suppressed: previous?.suppressed ?? 0 }, next] as const;
      },
    );
    if (!decision.emit) return;

    const annotations = {
      projectId: input.projectId,
      ...input.fields,
      ...(decision.suppressed > 0 ? { suppressedCount: decision.suppressed } : {}),
    };
    if (input.severity === "error") {
      yield* Effect.logWarning(input.event).pipe(Effect.annotateLogs(annotations));
      return;
    }
    yield* Effect.logInfo(input.event).pipe(Effect.annotateLogs(annotations));
  });

  return { emit } as const;
});
