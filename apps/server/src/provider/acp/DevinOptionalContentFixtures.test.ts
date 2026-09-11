import { describe, expect, it } from "vite-plus/test";

const MAX_CAPTURE_RECORD_BYTES = 512;
const MAX_CAPTURE_RECORDS = 32;
const NON_OPTIONAL_UPDATE_TYPES = new Set([
  "config_option_update",
  "current_mode_update",
  "available_commands_update",
  "session_info_update",
  "usage_update",
]);

export type DevinOptionalContentClassification = "ordinary text" | "unsupported";

export interface DevinSanitizedAcpCapture {
  readonly method: "session/update" | "session/elicitation" | "unknown";
  readonly updateType?: string;
  readonly contentType?: string;
  readonly classification: DevinOptionalContentClassification;
  readonly reason?: "redacted-size";
}

export const DEVIN_OPTIONAL_CONTENT_UNSUPPORTED_FIXTURE = {
  status: "unsupported",
  reason: "not-emitted-by-installed-devin-cli",
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeTag(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z][A-Za-z0-9._:-]{0,63}$/.test(value)
    ? value
    : undefined;
}

function boundedRecord(record: DevinSanitizedAcpCapture): DevinSanitizedAcpCapture {
  const encoded = new TextEncoder().encode(JSON.stringify(record));
  return encoded.byteLength <= MAX_CAPTURE_RECORD_BYTES
    ? record
    : { method: "unknown", classification: "unsupported", reason: "redacted-size" };
}

export function captureDevinAcpUpdate(event: unknown): DevinSanitizedAcpCapture | undefined {
  if (!isRecord(event) || event.direction !== "incoming" || event.stage !== "decoded") {
    return undefined;
  }

  const messages = Array.isArray(event.payload) ? event.payload : [event.payload];
  const message = messages.find(isRecord);
  if (!message) return undefined;

  const method =
    message.tag === "session/update"
      ? "session/update"
      : message.tag === "session/elicitation"
        ? "session/elicitation"
        : "unknown";
  if (method === "unknown") return undefined;

  const payload = isRecord(message.payload) ? message.payload : undefined;
  const update = payload && isRecord(payload.update) ? payload.update : undefined;
  const oversizedField =
    (typeof update?.sessionUpdate === "string" && update.sessionUpdate.length > 64) ||
    (isRecord(update?.content) &&
      typeof update.content.type === "string" &&
      update.content.type.length > 64);
  if (oversizedField) {
    return { method: "unknown", classification: "unsupported", reason: "redacted-size" };
  }
  const updateType = safeTag(update?.sessionUpdate);
  const content = update && isRecord(update.content) ? update.content : undefined;
  const contentType = safeTag(content?.type);
  return boundedRecord({
    method,
    ...(updateType ? { updateType } : {}),
    ...(contentType ? { contentType } : {}),
    classification: contentType === "text" ? "ordinary text" : "unsupported",
  });
}

export interface DevinAcpCapture {
  readonly write: (event: unknown) => void;
  readonly records: () => ReadonlyArray<DevinSanitizedAcpCapture>;
}

export function selectDevinOptionalContent(
  records: ReadonlyArray<DevinSanitizedAcpCapture>,
): ReadonlyArray<DevinSanitizedAcpCapture> {
  return records.filter(
    (record) =>
      record.classification !== "ordinary text" &&
      !NON_OPTIONAL_UPDATE_TYPES.has(record.updateType ?? ""),
  );
}

export function createDevinAcpCapture(enabled: boolean): DevinAcpCapture | undefined {
  if (!enabled) return undefined;
  const records: DevinSanitizedAcpCapture[] = [];
  return {
    write(event: unknown): void {
      const record = captureDevinAcpUpdate(event);
      if (record && records.length < MAX_CAPTURE_RECORDS) records.push(record);
    },
    records(): ReadonlyArray<DevinSanitizedAcpCapture> {
      return records.slice();
    },
  };
}

describe("Devin sanitized optional ACP fixtures", () => {
  it("redacts prompts, credentials, paths, environment values, and blobs", () => {
    const capture = createDevinAcpCapture(true);
    expect(capture).toBeDefined();
    if (!capture) return;
    capture.write({
      direction: "incoming",
      stage: "decoded",
      payload: [
        {
          tag: "session/update",
          payload: {
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "secret prompt" },
              authorization: "Bearer secret-token",
              workspace: "C:\\Users\\person\\project",
              environment: { SECRET: "secret-value" },
              blob: "a".repeat(10_000),
            },
          },
        },
      ],
    });

    const serialized = JSON.stringify(capture.records());
    expect(serialized).not.toContain("secret prompt");
    expect(serialized).not.toContain("secret-token");
    expect(serialized).not.toContain("C:\\Users\\person\\project");
    expect(serialized).not.toContain("secret-value");
    expect(serialized).not.toContain("a".repeat(1_000));
    expect(capture.records()).toEqual([
      {
        method: "session/update",
        updateType: "agent_message_chunk",
        contentType: "text",
        classification: "ordinary text",
      },
    ]);
  });

  it("bounds each record and the in-memory capture", () => {
    const capture = createDevinAcpCapture(true);
    expect(capture).toBeDefined();
    if (!capture) return;
    for (let index = 0; index < 40; index += 1) {
      capture.write({
        direction: "incoming",
        stage: "decoded",
        payload: [
          {
            tag: "session/update",
            payload: {
              update: {
                sessionUpdate: `not-safe-${"x".repeat(1_000)}-${index}`,
                content: { type: "unsupported" },
              },
            },
          },
        ],
      });
    }

    expect(capture.records()).toHaveLength(32);
    for (const record of capture.records()) {
      expect(new TextEncoder().encode(JSON.stringify(record)).byteLength).toBeLessThanOrEqual(512);
      expect(record.classification).toBe("unsupported");
      expect(record.reason).toBe("redacted-size");
    }
  });

  it("does not create capture state when capture is disabled", () => {
    expect(createDevinAcpCapture(false)).toBeUndefined();
  });

  it("keeps startup metadata out of optional fixture output", () => {
    expect(
      selectDevinOptionalContent([
        {
          method: "session/update",
          updateType: "agent_message_chunk",
          contentType: "text",
          classification: "ordinary text",
        },
        {
          method: "session/update",
          updateType: "available_commands_update",
          classification: "unsupported",
        },
        {
          method: "session/update",
          updateType: "future_optional_update",
          classification: "unsupported",
        },
      ]),
    ).toEqual([
      {
        method: "session/update",
        updateType: "future_optional_update",
        classification: "unsupported",
      },
    ]);
  });
});
