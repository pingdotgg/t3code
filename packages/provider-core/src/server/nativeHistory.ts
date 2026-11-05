import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class ProviderNativeHistoryError extends Schema.TaggedError<ProviderNativeHistoryError>()(
  "ProviderNativeHistoryError",
  {
    operation: Schema.Literals(["list", "items", "readSource"]),
    reason: Schema.Literals([
      "unsupported",
      "unavailable",
      "missing",
      "changed",
      "invalid_cursor",
      "limit_exceeded",
    ]),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Native history ${this.operation} failed (${this.reason}).`;
  }
}

export interface ProviderNativeHistoryThread {
  readonly nativeThreadId: string;
  readonly cwd: string;
  readonly title: string;
  readonly preview: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly source: string;
  readonly originator: string | null;
  readonly ephemeral: boolean;
}

export interface ProviderNativeHistoryItem {
  readonly nativeThreadId: string;
  readonly nativeTurnId: string;
  readonly nativeItemId: string;
  readonly kind: string;
  readonly role: "user" | "assistant" | "tool";
  readonly status: string | null;
  readonly createdAt: string | null;
  /** The digest covers the complete normalized visible evidence, not just this excerpt. */
  readonly digest: string;
  readonly readCursor: string;
  readonly text: string;
  readonly textOffset: number;
  readonly totalChars: number;
  readonly truncated: boolean;
  readonly match: { readonly start: number; readonly end: number } | null;
}

export interface ProviderNativeHistory {
  readonly list: (input: {
    readonly cwd: string;
    readonly filterCwd?: string;
    readonly archived?: boolean;
    readonly cursor?: string;
    readonly limit?: number;
  }) => Effect.Effect<
    {
      readonly threads: ReadonlyArray<ProviderNativeHistoryThread>;
      readonly nextCursor: string | null;
    },
    ProviderNativeHistoryError
  >;
  readonly items: (input: {
    readonly cwd: string;
    readonly nativeThreadId: string;
    readonly nativeTurnId?: string;
    readonly cursor?: string;
    readonly limit?: number;
    readonly maxCharsPerItem?: number;
    /** Case-insensitive literal matching examines complete visible text before making excerpts. */
    readonly query?: string;
  }) => Effect.Effect<
    {
      readonly thread: ProviderNativeHistoryThread;
      readonly items: ReadonlyArray<ProviderNativeHistoryItem>;
      readonly examinedItems: number;
      readonly nextCursor: string | null;
    },
    ProviderNativeHistoryError
  >;
  readonly readSource: (input: {
    readonly cwd: string;
    readonly nativeThreadId: string;
    readonly readCursor: string;
    readonly digest: string;
    readonly textOffset?: number;
    readonly maxChars?: number;
  }) => Effect.Effect<
    {
      readonly thread: ProviderNativeHistoryThread;
      readonly item: ProviderNativeHistoryItem;
      readonly nextTextOffset: number | null;
    },
    ProviderNativeHistoryError
  >;
}
