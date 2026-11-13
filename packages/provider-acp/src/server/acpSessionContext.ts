// Accumulated context type for the extracted ACP session behaviour modules.
// Each stage adds the members returned by the module created before it.
import type * as Effect from "effect/Effect";
import type { createAcpSessionCore } from "./acpSessionCore.ts";
import type { createAcpSessionIdentity } from "./acpSessionIdentity.ts";
import type { createAcpSessionTerminals } from "./acpSessionTerminals.ts";
import type { createAcpTurnProjection } from "./acpTurnProjection.ts";
import type { createAcpTextStreaming } from "./acpTextStreaming.ts";
import type { createAcpSubagentMessages } from "./acpSubagentMessages.ts";
import type { createAcpSubagentTurn } from "./acpSubagentTurn.ts";
import type { createAcpNativeChildren } from "./acpNativeChildren.ts";
import type { createAcpToolEmission } from "./acpToolEmission.ts";
import type { createAcpNotices } from "./acpNotices.ts";
import type { createAcpBackgroundContinuation } from "./acpBackgroundContinuation.ts";
import type { createAcpAgentTerminalProjection } from "./acpAgentTerminalProjection.ts";
import type { createAcpSessionUpdates } from "./acpSessionUpdates.ts";
import type { createAcpRuntimeRequests } from "./acpRuntimeRequests.ts";
import type { createAcpCarryoverSubagents } from "./acpCarryoverSubagents.ts";
import type { createAcpRuntimeWiring } from "./acpRuntimeWiring.ts";
import type { createAcpRuntimeHandlers } from "./acpRuntimeHandlers.ts";
import type { createAcpRuntimeLifecycle } from "./acpRuntimeLifecycle.ts";
import type { createAcpSessionActivation } from "./acpSessionActivation.ts";
import type { createAcpTurnSetup } from "./acpTurnSetup.ts";
import type { createAcpTurnFinalize } from "./acpTurnFinalize.ts";
import type { createAcpTurnPrompt } from "./acpTurnPrompt.ts";
import type { createAcpTurnStart } from "./acpTurnStart.ts";
import type { createAcpSessionFinalizer } from "./acpSessionFinalizer.ts";

export type AcpSessionCore = Effect.Success<ReturnType<typeof createAcpSessionCore>>;
export type AcpSessionCtx1 = AcpSessionCore & Effect.Success<ReturnType<typeof createAcpSessionIdentity>>;
export type AcpSessionCtx2 = AcpSessionCtx1 & Effect.Success<ReturnType<typeof createAcpSessionTerminals>>;
export type AcpSessionCtx3 = AcpSessionCtx2 & Effect.Success<ReturnType<typeof createAcpTurnProjection>>;
export type AcpSessionCtx4 = AcpSessionCtx3 & Effect.Success<ReturnType<typeof createAcpTextStreaming>>;
export type AcpSessionCtx5 = AcpSessionCtx4 & ReturnType<typeof createAcpSubagentMessages>;
export type AcpSessionCtx6 = AcpSessionCtx5 & ReturnType<typeof createAcpSubagentTurn>;
export type AcpSessionCtx7 = AcpSessionCtx6 & ReturnType<typeof createAcpNativeChildren>;
export type AcpSessionCtx8 = AcpSessionCtx7 & ReturnType<typeof createAcpToolEmission>;
export type AcpSessionCtx9 = AcpSessionCtx8 & ReturnType<typeof createAcpNotices>;
export type AcpSessionCtx10 = AcpSessionCtx9 & ReturnType<typeof createAcpBackgroundContinuation>;
export type AcpSessionCtx11 = AcpSessionCtx10 & ReturnType<typeof createAcpAgentTerminalProjection>;
export type AcpSessionCtx12 = AcpSessionCtx11 & ReturnType<typeof createAcpSessionUpdates>;
export type AcpSessionCtx13 = AcpSessionCtx12 & ReturnType<typeof createAcpRuntimeRequests>;
export type AcpSessionCtx14 = AcpSessionCtx13 & ReturnType<typeof createAcpCarryoverSubagents>;
export type AcpSessionCtx15 = AcpSessionCtx14 & ReturnType<typeof createAcpRuntimeWiring>;
export type AcpSessionCtx16 = AcpSessionCtx15 & ReturnType<typeof createAcpRuntimeHandlers>;
export type AcpSessionCtx17 = AcpSessionCtx16 & ReturnType<typeof createAcpRuntimeLifecycle>;
export type AcpSessionCtx18 = AcpSessionCtx17 & Effect.Success<ReturnType<typeof createAcpSessionActivation>>;
export type AcpSessionCtx19 = AcpSessionCtx18 & Effect.Success<ReturnType<typeof createAcpTurnSetup>>;
export type AcpSessionCtx20 = AcpSessionCtx19 & ReturnType<typeof createAcpTurnFinalize>;
export type AcpSessionCtx21 = AcpSessionCtx20 & ReturnType<typeof createAcpTurnPrompt>;
export type AcpSessionCtx22 = AcpSessionCtx21 & ReturnType<typeof createAcpTurnStart>;
export type AcpSessionCtx23 = AcpSessionCtx22 & Effect.Success<ReturnType<typeof createAcpSessionFinalizer>>;

/** Fully assembled session context. */
export type AcpSessionContext = AcpSessionCtx23;
