import * as Schema from "effect/Schema";
import { ThreadId, TurnItemId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const SecretDeliveryStatus = Schema.Literals(["available", "deleted", "expired"]);
export const SecretDeliveryReceipt = Schema.Struct({
  deliveryId: TurnItemId,
  status: SecretDeliveryStatus,
  expiresAt: Schema.Number,
});
export type SecretDeliveryReceipt = typeof SecretDeliveryReceipt.Type;
export const SecretDeliveryInput = Schema.Struct({ threadId: ThreadId, deliveryId: TurnItemId });
export type SecretDeliveryInput = typeof SecretDeliveryInput.Type;
export const SendSecretInput = Schema.Struct({
  filePath: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  clientRequestId: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
});
export type SendSecretInput = typeof SendSecretInput.Type;
export class SecretDeliveryError extends Schema.TaggedError<SecretDeliveryError>()(
  "SecretDeliveryError",
  {
    reason: Schema.Literals(["invalid_file", "unavailable", "storage_failed", "record_failed"]),
  },
) {
  override get message(): string {
    return {
      invalid_file: "Use an owner-private regular UTF-8 file of at most 64 KiB, without symlinks.",
      unavailable: "This secret delivery is unavailable.",
      storage_failed: "Could not access secret delivery storage.",
      record_failed: "Could not record the secret delivery. Retry with the same clientRequestId.",
    }[this.reason];
  }
}
