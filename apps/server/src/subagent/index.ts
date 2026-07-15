/**
 * Unified Sub-Agent System - Public API
 *
 * This module provides cross-provider sub-agent orchestration for SergeCode.
 * Any provider can spawn agents on any other provider without MCP capability gates.
 */

// Core coordinator
export {
  UniversalSubAgentCoordinator,
  UniversalSubAgentCoordinatorLive,
  type UniversalSubAgentContext,
} from "./UniversalSubAgentCoordinator.ts";

// Tool and handlers
export { UnifiedSubAgentTool } from "./UnifiedSubAgentTool.ts";
export { UnifiedSubAgentToolHandlerLive } from "./UnifiedSubAgentToolHandler.ts";
export * from "./UnifiedSubAgentHandlers.ts";

// Integration helpers
export { createUnifiedSubAgentToolHandler, mapCodexCollabAgentToUnified } from "./integration.ts";

// Provider registry
export {
  SubAgentProviderRegistry,
  SubAgentProviderRegistryLive,
} from "./SubAgentProviderRegistry.ts";
export type {
  SubAgentProviderInfo,
  SubAgentProviderFilter,
  SubAgentModelInfo,
} from "./SubAgentProviderInfo.ts";

// Concurrency management
export { ConcurrencyLimits, ConcurrencyLimitsLive } from "./ConcurrencyLimits.ts";

// Workflow system
export { WorkflowEngine, WorkflowEngineLive } from "./workflows/WorkflowEngine.ts";
export { WorkflowStorage, WorkflowStorageLive } from "./workflows/WorkflowStorage.ts";
export { loadBuiltinWorkflow, isBuiltinWorkflow } from "./workflows/BuiltinWorkflows.ts";

// Error types
export { SubAgentError } from "./SubAgentError.ts";
