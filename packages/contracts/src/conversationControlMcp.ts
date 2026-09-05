import * as Schema from "effect/Schema";

import {
  CommandId,
  NonNegativeInt,
  RunId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ProviderOptionDescriptor, ProviderOptionSelection } from "./model.ts";
import { ProviderInteractionMode, RuntimeMode } from "./providerPolicy.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";

function hasWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= value.length) return false;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

const WellFormedRequestKey = Schema.String.check(
  Schema.makeFilter(
    (value: string) =>
      (value.length > 0 && value === value.trim()) ||
      "The request key must be non-empty and must not have surrounding whitespace.",
  ),
  Schema.isMaxLength(256),
  Schema.makeFilter(
    (value: string) =>
      hasWellFormedUnicode(value) ||
      "The request key must not contain unpaired Unicode surrogates.",
  ),
).annotate({ description: "Stable idempotency key to reuse when retrying this mutation." });

export const ConversationConfigurationInput = Schema.Struct({
  threadId: Schema.optional(
    ThreadId.annotate({
      description: "Target thread in the calling project; defaults to this thread.",
    }),
  ),
});
export type ConversationConfigurationInput = typeof ConversationConfigurationInput.Type;

export const ConversationConfigurationSelection = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  driverKind: Schema.NullOr(ProviderDriverKind),
  model: Schema.String,
  options: Schema.Array(ProviderOptionSelection),
});
export type ConversationConfigurationSelection = typeof ConversationConfigurationSelection.Type;

export const ConversationConfigurationProvider = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  driverKind: ProviderDriverKind,
  displayName: Schema.NullOr(Schema.String),
  selectable: Schema.Boolean,
  constraints: Schema.Array(Schema.String),
  models: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      label: Schema.NullOr(Schema.String),
      options: Schema.Array(ProviderOptionDescriptor),
    }),
  ),
});
export type ConversationConfigurationProvider = typeof ConversationConfigurationProvider.Type;

export const ConversationConfigurationResult = Schema.Struct({
  threadId: ThreadId,
  selection: ConversationConfigurationSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  allowedRuntimeModes: Schema.Array(RuntimeMode),
  allowedInteractionModes: Schema.Array(ProviderInteractionMode),
  providers: Schema.Array(ConversationConfigurationProvider),
});
export type ConversationConfigurationResult = typeof ConversationConfigurationResult.Type;

export const ConversationConfigureInput = Schema.Struct({
  threadId: Schema.optional(
    ThreadId.annotate({
      description: "Target thread in the calling project; defaults to this thread.",
    }),
  ),
  providerInstanceId: Schema.optional(
    ProviderInstanceId.annotate({
      description: "Configured provider instance id returned by t3_thread_configuration.",
    }),
  ),
  model: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description: "Model id advertised for the selected provider instance.",
    }),
  ),
  options: Schema.optional(
    Schema.Array(ProviderOptionSelection).annotate({
      description:
        "Full replacement option list for the selected model. Pass [] to clear all options.",
    }),
  ),
  runtimeMode: Schema.optional(RuntimeMode),
  interactionMode: Schema.optional(ProviderInteractionMode),
  clientRequestId: Schema.optional(WellFormedRequestKey),
}).check(
  Schema.makeFilter(
    (input) =>
      input.providerInstanceId !== undefined ||
      input.model !== undefined ||
      input.options !== undefined ||
      input.runtimeMode !== undefined ||
      input.interactionMode !== undefined ||
      "Provide at least one selection, runtime mode, or interaction mode change.",
  ),
);
export type ConversationConfigureInput = typeof ConversationConfigureInput.Type;

export const ConversationConfigurationBehavior = Schema.Literals([
  "unchanged",
  "next_turn",
  "session_detach_requested",
  "handoff_required_next_turn",
]);
export type ConversationConfigurationBehavior = typeof ConversationConfigurationBehavior.Type;

export const ConversationConfigurationReceipt = Schema.Struct({
  commandId: CommandId,
  commandType: Schema.Literals([
    "thread.model-selection.set",
    "provider.switch",
    "thread.runtime-mode.set",
    "thread.interaction-mode.set",
  ]),
  sequence: NonNegativeInt,
  eventIds: Schema.Array(Schema.String),
});
export type ConversationConfigurationReceipt = typeof ConversationConfigurationReceipt.Type;

export const ConversationConfigurationChange = Schema.Struct({
  setting: Schema.Literals(["selection", "runtime_mode", "interaction_mode"]),
  behavior: ConversationConfigurationBehavior,
  requestedEffects: Schema.Array(Schema.Literal("provider_session_detach")),
  receipt: Schema.NullOr(ConversationConfigurationReceipt),
});
export type ConversationConfigurationChange = typeof ConversationConfigurationChange.Type;

export const ConversationConfigureResult = Schema.Struct({
  threadId: ThreadId,
  outcome: Schema.Literals(["unchanged", "applied", "partially_applied"]),
  observation: Schema.Literals(["post_dispatch", "pre_dispatch_fallback"]),
  selection: ConversationConfigurationSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  activeRunIds: Schema.Array(RunId),
  queuedRunIds: Schema.Array(RunId),
  changes: Schema.Array(ConversationConfigurationChange),
  errors: Schema.Array(
    Schema.Struct({
      setting: Schema.Literals(["selection", "runtime_mode", "interaction_mode"]),
      message: Schema.String,
    }),
  ),
  retryGuidance: Schema.Struct({
    sameClientRequestId: Schema.Literal("replays_durable_decisions"),
    afterRejectedLeg: Schema.Literal("use_new_client_request_id"),
  }),
});
export type ConversationConfigureResult = typeof ConversationConfigureResult.Type;
