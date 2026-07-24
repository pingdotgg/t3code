import { MessageId, type TurnId } from "@t3tools/contracts";

export function assistantSegmentBaseKeyFromRuntimeItem(
  itemId: string | undefined,
  turnId: string | undefined,
  eventId: string,
): string {
  return String(itemId ?? turnId ?? eventId);
}

export function assistantSegmentMessageId(
  baseKey: string,
  segmentIndex: number,
  turnId?: TurnId,
): MessageId {
  const scopedBase = turnId ? `${turnId}:${baseKey}` : baseKey;
  return MessageId.make(
    segmentIndex === 0
      ? `assistant:${scopedBase}`
      : `assistant:${scopedBase}:segment:${segmentIndex}`,
  );
}
