import type {
  PreviewCloseInput,
  PreviewManagerError,
  PreviewOpenInput,
  PreviewRestartInput,
  PreviewSessionSnapshot,
  PreviewSessionStreamEvent,
  PreviewSubscribeInput,
} from "@forma/contracts";
import { Context } from "effect";
import type { Effect, Stream } from "effect";

export interface PreviewManagerShape {
  readonly open: (
    input: PreviewOpenInput,
  ) => Effect.Effect<PreviewSessionSnapshot, PreviewManagerError>;
  readonly close: (input: PreviewCloseInput) => Effect.Effect<void, PreviewManagerError>;
  readonly restart: (
    input: PreviewRestartInput,
  ) => Effect.Effect<PreviewSessionSnapshot, PreviewManagerError>;
  readonly subscribe: (
    input: PreviewSubscribeInput,
  ) => Stream.Stream<PreviewSessionStreamEvent, PreviewManagerError>;
}

export class PreviewManager extends Context.Service<PreviewManager, PreviewManagerShape>()(
  "forma/preview/Services/Manager/PreviewManager",
) {}
