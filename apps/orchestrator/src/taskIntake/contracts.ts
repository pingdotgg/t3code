import { Schema } from "effect";
import {
  TaskIntakeDeliveryResult,
  TaskIntakeMessage,
  TaskIntakeReply,
  TaskIntakeResolution,
} from "@t3tools/contracts";

export const decodeTaskIntakeMessage = Schema.decodeUnknownSync(TaskIntakeMessage);
export const decodeTaskIntakeReply = Schema.decodeUnknownSync(TaskIntakeReply);
export const decodeTaskIntakeResolution = Schema.decodeUnknownSync(TaskIntakeResolution);
export const decodeTaskIntakeDeliveryResult = Schema.decodeUnknownSync(TaskIntakeDeliveryResult);

export type {
  TaskIntakeConversationRef,
  TaskIntakeDeliveryResult,
  TaskIntakeExternalLinkKind,
  TaskIntakeMessage,
  TaskIntakeReply,
  TaskIntakeResolution,
  TaskIntakeSource,
} from "@t3tools/contracts";
