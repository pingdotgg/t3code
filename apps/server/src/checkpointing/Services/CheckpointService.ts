/**
 * CheckpointService - Application orchestrator for checkpoint workflows.
 *
 * Coordinates `CheckpointStore` (Git refs), `CheckpointRepository` (metadata), and
 * provider timeline operations resolved through `ProviderSessionDirectory` and
 * `ProviderAdapterRegistry` (read/rollback/hasSession on adapters).
 *
 * This service owns checkpoint workflow rules and validation, while concrete
 * storage/process details stay in lower-level services.
 *
 * @module CheckpointService
 */
import type {
  ProviderGetCheckpointDiffInput,
  ProviderGetCheckpointDiffResult,
  ProviderListCheckpointsInput,
  ProviderListCheckpointsResult,
  ProviderRevertToCheckpointInput,
  ProviderRevertToCheckpointResult,
} from "@t3tools/contracts";
import { ServiceMap } from "effect";
import type { Effect } from "effect";

import type { CheckpointServiceError } from "../Errors.ts";

export interface InitializeCheckpointSessionInput {
  readonly providerSessionId: string;
  readonly cwd: string;
}

export interface CaptureCurrentTurnInput {
  readonly providerSessionId: string;
  readonly turnId?: string;
  readonly status?: string;
}

export interface CheckpointServiceShape {
  /**
   * Initialize root checkpoint and metadata for a provider session.
   */
  readonly initializeForSession: (
    input: InitializeCheckpointSessionInput,
  ) => Effect.Effect<void, CheckpointServiceError>;

  /**
   * Capture the current thread turn into checkpoint refs/metadata.
   */
  readonly captureCurrentTurn: (
    input: CaptureCurrentTurnInput,
  ) => Effect.Effect<void, CheckpointServiceError>;

  /**
   * List checkpoints for a provider session.
   */
  readonly listCheckpoints: (
    input: ProviderListCheckpointsInput,
  ) => Effect.Effect<ProviderListCheckpointsResult, CheckpointServiceError>;

  /**
   * Diff two checkpoint turn counts for a provider session.
   */
  readonly getCheckpointDiff: (
    input: ProviderGetCheckpointDiffInput,
  ) => Effect.Effect<ProviderGetCheckpointDiffResult, CheckpointServiceError>;

  /**
   * Revert provider/filesystem state to a checkpoint.
   */
  readonly revertToCheckpoint: (
    input: ProviderRevertToCheckpointInput,
  ) => Effect.Effect<ProviderRevertToCheckpointResult, CheckpointServiceError>;

  /**
   * Release in-memory checkpoint session state after session shutdown.
   *
   * This only clears local coordination state (locks/cwd tracking). It does not
   * delete durable checkpoint metadata or git refs.
   */
  readonly releaseSession: (input: {
    readonly providerSessionId: string;
  }) => Effect.Effect<void, CheckpointServiceError>;
}

/**
 * CheckpointService - Service tag for checkpoint orchestration.
 */
export class CheckpointService extends ServiceMap.Service<
  CheckpointService,
  CheckpointServiceShape
>()("checkpointing/CheckpointService") {}
