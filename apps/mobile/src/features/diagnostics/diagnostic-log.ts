export interface DiagnosticAppIdentity {
  readonly version: string;
  readonly build: string;
  readonly updateId: string | null;
  readonly runtimeVersion: string | null;
  readonly platform: string;
  readonly osVersion: string;
}

export type DiagnosticEvent =
  | { readonly type: "app.started" | "logs.cleared"; readonly app: DiagnosticAppIdentity }
  | { readonly type: "app.state"; readonly state: string }
  | {
      readonly type: "thread.selected";
      readonly environmentId: string;
      readonly threadId: string;
    }
  | {
      readonly type: "navigation.requested";
      readonly name: string;
      readonly environmentId?: string;
      readonly threadId?: string;
    }
  | {
      readonly type: "navigation.changed";
      readonly index: number;
      readonly routes: ReadonlyArray<{
        readonly name: string;
        readonly key: string;
        readonly environmentId?: string;
        readonly threadId?: string;
      }>;
    }
  | {
      readonly type: "navigation.native";
      readonly phase: "willAppear" | "didAppear" | "willDisappear" | "didDisappear";
      readonly name: string;
      readonly key: string;
    }
  | {
      readonly type: "navigation.gate";
      readonly phase: "held" | "released" | "queued";
      readonly pending: number;
    }
  | {
      readonly type: "connections.changed";
      readonly network: string;
      readonly connections: ReadonlyArray<{
        readonly environmentId: string;
        readonly state: string;
        readonly enabled: boolean;
      }>;
    };

export interface DiagnosticLogStorage {
  readonly size: () => number;
  readonly append: (bytes: Uint8Array) => void;
  readonly rotate: () => void;
  readonly read: () => string;
  readonly clear: () => void;
}

// Two files retain at most 256 KiB across launches; each event is written before returning.
const FILE_LIMIT = 128 * 1024;
const EVENT_LIMIT = 8 * 1024;

export function createDiagnosticLog(
  storage: DiagnosticLogStorage,
  session: string,
  now: () => string,
) {
  const encoder = new TextEncoder();
  let dropped = 0;
  return {
    record(event: DiagnosticEvent) {
      try {
        const bytes = encoder.encode(`${JSON.stringify({ time: now(), session, ...event })}\n`);
        if (bytes.byteLength > EVENT_LIMIT) {
          dropped += 1;
          return;
        }
        if (storage.size() + bytes.byteLength > FILE_LIMIT) storage.rotate();
        storage.append(bytes);
      } catch {
        // Diagnostics must never prevent a tap or a connection transition from completing.
        dropped += 1;
      }
    },
    report(app: DiagnosticAppIdentity) {
      return [
        "T3 Code mobile diagnostics (v1)",
        JSON.stringify({ exportedAt: now(), app, droppedEventsThisSession: dropped }),
        "Events contain identifiers and app state, without conversation text or credentials.",
        "",
        storage.read(),
      ].join("\n");
    },
    clear() {
      storage.clear();
      dropped = 0;
    },
  };
}

let recorder: ((event: DiagnosticEvent) => void) | undefined;

export function recordDiagnostic(event: DiagnosticEvent) {
  recorder?.(event);
}

export function installDiagnosticRecorder(record: (event: DiagnosticEvent) => void) {
  recorder = record;
  return () => {
    if (recorder === record) recorder = undefined;
  };
}
