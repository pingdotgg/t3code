import { EventEmitter } from "node:events";
import type {
  AppSettings,
  AppSettingsUpdateInput,
  ProjectAddInput,
  ProjectAddResult,
  ProjectListResult,
  ProjectRemoveInput,
  ProjectUpdateScriptsInput,
  ProjectUpdateScriptsResult,
  StateBootstrapResult,
  StateCatchUpInput,
  StateCatchUpResult,
  StateEvent,
  StateListMessagesInput,
  StateListMessagesResult,
  ThreadsCreateInput,
  ThreadsDeleteInput,
  ThreadsMarkVisitedInput,
  ThreadsUpdateBranchInput,
  ThreadsUpdateModelInput,
  ThreadsUpdateResult,
  ThreadsUpdateTerminalStateInput,
  ThreadsUpdateTitleInput,
} from "@t3tools/contracts";
import { createLogger } from "./logger";
import type { LiveStoreStateMirror } from "./livestore/liveStoreEngine";
import { diffCatchUpResults, diffListMessagesResults, diffStateSnapshots } from "./livestore/parity";
import type { ApplyCheckpointRevertInput, StateSyncEngine } from "./stateSyncEngine";

interface LiveStoreReadPilotEvents {
  stateEvent: [event: StateEvent];
}

type LiveStoreReadSource = "delegate" | "livestore";
type LiveStoreReadRoute = "state.bootstrap" | "state.catchUp" | "state.listMessages";
type LiveStoreFallbackReason = "mirror-error" | "empty-mirror";

export interface LiveStoreReadPilotMetrics {
  routeReadCounts: Record<LiveStoreReadRoute, { livestore: number; delegate: number }>;
  fallbackCounts: Record<LiveStoreReadRoute, { "mirror-error": number; "empty-mirror": number }>;
}

export interface LiveStoreReadPilotStateSyncEngineOptions {
  delegate: StateSyncEngine;
  mirror: LiveStoreStateMirror;
  enableBootstrapParityCheck?: boolean;
  enableCatchUpParityCheck?: boolean;
  enableListMessagesParityCheck?: boolean;
  disableDelegateReadFallback?: boolean;
}

export class LiveStoreReadPilotStateSyncEngine
  extends EventEmitter<LiveStoreReadPilotEvents>
  implements StateSyncEngine
{
  private readonly delegate: StateSyncEngine;
  private readonly mirror: LiveStoreStateMirror;
  private readonly logger = createLogger("livestore-read-pilot");
  private readonly unsubscribeDelegate: () => void;
  private readonly enableBootstrapParityCheck: boolean;
  private readonly enableCatchUpParityCheck: boolean;
  private readonly enableListMessagesParityCheck: boolean;
  private readonly disableDelegateReadFallback: boolean;
  private closed = false;
  private bootstrapSource: LiveStoreReadSource = "delegate";
  private catchUpSource: LiveStoreReadSource = "delegate";
  private listMessagesSource: LiveStoreReadSource = "delegate";
  private bootstrapParityState: "unknown" | "in-parity" | "drift" = "unknown";
  private catchUpParityState: "unknown" | "in-parity" | "drift" = "unknown";
  private listMessagesParityState: "unknown" | "in-parity" | "drift" = "unknown";
  private readonly metrics: LiveStoreReadPilotMetrics = {
    routeReadCounts: {
      "state.bootstrap": { livestore: 0, delegate: 0 },
      "state.catchUp": { livestore: 0, delegate: 0 },
      "state.listMessages": { livestore: 0, delegate: 0 },
    },
    fallbackCounts: {
      "state.bootstrap": { "mirror-error": 0, "empty-mirror": 0 },
      "state.catchUp": { "mirror-error": 0, "empty-mirror": 0 },
      "state.listMessages": { "mirror-error": 0, "empty-mirror": 0 },
    },
  };

  constructor(options: LiveStoreReadPilotStateSyncEngineOptions) {
    super();
    this.delegate = options.delegate;
    this.mirror = options.mirror;
    this.enableBootstrapParityCheck = options.enableBootstrapParityCheck ?? false;
    this.enableCatchUpParityCheck = options.enableCatchUpParityCheck ?? false;
    this.enableListMessagesParityCheck = options.enableListMessagesParityCheck ?? false;
    this.disableDelegateReadFallback = options.disableDelegateReadFallback ?? false;
    this.unsubscribeDelegate = this.delegate.onStateEvent((event) => {
      this.emit("stateEvent", event);
      void this.mirror
        .mirrorStateEvent(event)
        .then((mirrored) => {
          if (mirrored === false) {
            this.logger.warn("mirror state event in read pilot reported unsuccessful write", {
              seq: event.seq,
            });
          }
        })
        .catch((error) => {
          this.logger.warn("failed to mirror state event in read pilot", {
            error,
            seq: event.seq,
          });
        });
    });
  }

  onStateEvent(listener: (event: StateEvent) => void): () => void {
    this.on("stateEvent", listener);
    return () => {
      this.off("stateEvent", listener);
    };
  }

  loadSnapshot(): StateBootstrapResult {
    try {
      const snapshot = this.mirror.debugReadSnapshot();
      if (this.enableBootstrapParityCheck) {
        this.checkBootstrapParity(snapshot);
      }
      if (snapshot.lastStateSeq === 0 && !this.disableDelegateReadFallback) {
        const delegateSnapshot = this.delegate.loadSnapshot();
        this.logReadSourceChange("state.bootstrap", this.bootstrapSource, "delegate", {
          lastStateSeq: delegateSnapshot.lastStateSeq,
        });
        this.recordReadRoute("state.bootstrap", "delegate");
        this.recordFallback("state.bootstrap", "empty-mirror");
        this.bootstrapSource = "delegate";
        return delegateSnapshot;
      }
      this.logReadSourceChange("state.bootstrap", this.bootstrapSource, "livestore", {
        lastStateSeq: snapshot.lastStateSeq,
      });
      this.recordReadRoute("state.bootstrap", "livestore");
      this.bootstrapSource = "livestore";
      return snapshot;
    } catch (error) {
      if (this.disableDelegateReadFallback) {
        this.logger.error("failed to read bootstrap from livestore mirror with fallback disabled", {
          error,
        });
        throw error;
      }
      this.logger.warn("failed to read bootstrap from livestore mirror; using delegate", { error });
      this.recordFallback("state.bootstrap", "mirror-error");
    }
    const snapshot = this.delegate.loadSnapshot();
    this.logReadSourceChange("state.bootstrap", this.bootstrapSource, "delegate", {
      lastStateSeq: snapshot.lastStateSeq,
    });
    this.recordReadRoute("state.bootstrap", "delegate");
    this.bootstrapSource = "delegate";
    return snapshot;
  }

  private checkBootstrapParity(mirrorSnapshot: StateBootstrapResult): void {
    let delegateSnapshot: StateBootstrapResult;
    try {
      delegateSnapshot = this.delegate.loadSnapshot();
    } catch (error) {
      this.logger.warn("bootstrap parity check failed to read delegate snapshot", { error });
      return;
    }

    const diffs = diffStateSnapshots(delegateSnapshot, mirrorSnapshot);
    if (diffs.length === 0) {
      if (this.bootstrapParityState !== "in-parity") {
        this.bootstrapParityState = "in-parity";
        this.logger.info("livestore read pilot bootstrap parity check passed", {
          lastStateSeq: mirrorSnapshot.lastStateSeq,
        });
      }
      return;
    }

    this.bootstrapParityState = "drift";
    this.logger.warn("livestore read pilot bootstrap parity drift detected", {
      diffCount: diffs.length,
      samplePaths: diffs.slice(0, 5).map((diff) => diff.path),
      delegateLastStateSeq: delegateSnapshot.lastStateSeq,
      mirrorLastStateSeq: mirrorSnapshot.lastStateSeq,
    });
  }

  listMessages(raw: StateListMessagesInput): StateListMessagesResult {
    try {
      const result = this.mirror.debugListMessages(raw);
      if (this.enableListMessagesParityCheck) {
        this.checkListMessagesParity(raw, result);
      }
      this.logReadSourceChange("state.listMessages", this.listMessagesSource, "livestore", {
        threadId: raw.threadId,
      });
      this.recordReadRoute("state.listMessages", "livestore");
      this.listMessagesSource = "livestore";
      return result;
    } catch (error) {
      if (this.disableDelegateReadFallback) {
        this.logger.error(
          "failed to list messages from livestore mirror with fallback disabled",
          {
            error,
            threadId: raw.threadId,
          },
        );
        throw error;
      }
      this.recordFallback("state.listMessages", "mirror-error");
      this.logger.warn("failed to list messages from livestore mirror; using delegate", {
        error,
        threadId: raw.threadId,
      });
      const result = this.delegate.listMessages(raw);
      this.logReadSourceChange("state.listMessages", this.listMessagesSource, "delegate", {
        threadId: raw.threadId,
      });
      this.recordReadRoute("state.listMessages", "delegate");
      this.listMessagesSource = "delegate";
      return result;
    }
  }

  private checkListMessagesParity(
    raw: StateListMessagesInput,
    mirrorResult: StateListMessagesResult,
  ): void {
    let delegateResult: StateListMessagesResult;
    try {
      delegateResult = this.delegate.listMessages(raw);
    } catch (error) {
      this.logger.warn("list-messages parity check failed to read delegate listMessages", { error });
      return;
    }

    const diffs = diffListMessagesResults(delegateResult, mirrorResult);
    if (diffs.length === 0) {
      if (this.listMessagesParityState !== "in-parity") {
        this.listMessagesParityState = "in-parity";
        this.logger.info("livestore read pilot list-messages parity check passed", {
          threadId: raw.threadId,
          offset: raw.offset ?? 0,
          limit: raw.limit ?? 200,
        });
      }
      return;
    }

    this.listMessagesParityState = "drift";
    this.logger.warn("livestore read pilot list-messages parity drift detected", {
      threadId: raw.threadId,
      offset: raw.offset ?? 0,
      limit: raw.limit ?? 200,
      diffCount: diffs.length,
      sampleDiffs: diffs.slice(0, 5),
    });
  }

  catchUp(raw: StateCatchUpInput): StateCatchUpResult {
    const afterSeq = raw.afterSeq ?? 0;
    try {
      const result = this.mirror.debugCatchUp(afterSeq);
      if (this.enableCatchUpParityCheck) {
        this.checkCatchUpParity(raw, result);
      }
      this.logReadSourceChange("state.catchUp", this.catchUpSource, "livestore", {
        afterSeq,
      });
      this.recordReadRoute("state.catchUp", "livestore");
      this.catchUpSource = "livestore";
      return result;
    } catch (error) {
      if (this.disableDelegateReadFallback) {
        this.logger.error("failed to catch up from livestore mirror with fallback disabled", {
          error,
          afterSeq,
        });
        throw error;
      }
      this.recordFallback("state.catchUp", "mirror-error");
      this.logger.warn("failed to catch up from livestore mirror; using delegate", {
        error,
        afterSeq,
      });
      const result = this.delegate.catchUp(raw);
      this.logReadSourceChange("state.catchUp", this.catchUpSource, "delegate", {
        afterSeq,
      });
      this.recordReadRoute("state.catchUp", "delegate");
      this.catchUpSource = "delegate";
      return result;
    }
  }

  debugReadMetrics(): LiveStoreReadPilotMetrics {
    return {
      routeReadCounts: {
        "state.bootstrap": { ...this.metrics.routeReadCounts["state.bootstrap"] },
        "state.catchUp": { ...this.metrics.routeReadCounts["state.catchUp"] },
        "state.listMessages": { ...this.metrics.routeReadCounts["state.listMessages"] },
      },
      fallbackCounts: {
        "state.bootstrap": { ...this.metrics.fallbackCounts["state.bootstrap"] },
        "state.catchUp": { ...this.metrics.fallbackCounts["state.catchUp"] },
        "state.listMessages": { ...this.metrics.fallbackCounts["state.listMessages"] },
      },
    };
  }

  isReadFallbackDisabled(): boolean {
    return this.disableDelegateReadFallback;
  }

  private checkCatchUpParity(raw: StateCatchUpInput, mirrorResult: StateCatchUpResult): void {
    let delegateResult: StateCatchUpResult;
    try {
      delegateResult = this.delegate.catchUp(raw);
    } catch (error) {
      this.logger.warn("catch-up parity check failed to read delegate catch-up", { error });
      return;
    }

    const diffs = diffCatchUpResults(delegateResult, mirrorResult);
    if (diffs.length === 0) {
      if (this.catchUpParityState !== "in-parity") {
        this.catchUpParityState = "in-parity";
        this.logger.info("livestore read pilot catch-up parity check passed", {
          afterSeq: raw.afterSeq ?? 0,
          lastStateSeq: mirrorResult.lastStateSeq,
        });
      }
      return;
    }

    this.catchUpParityState = "drift";
    this.logger.warn("livestore read pilot catch-up parity drift detected", {
      afterSeq: raw.afterSeq ?? 0,
      diffCount: diffs.length,
      sampleDiffs: diffs.slice(0, 5),
      delegateLastStateSeq: delegateResult.lastStateSeq,
      mirrorLastStateSeq: mirrorResult.lastStateSeq,
    });
  }

  private logReadSourceChange(
    route: LiveStoreReadRoute,
    previous: LiveStoreReadSource,
    next: LiveStoreReadSource,
    metadata: Record<string, unknown>,
  ): void {
    if (previous === next) {
      return;
    }
    this.logger.info(`serving ${route} from ${next}`, {
      source: next,
      previousSource: previous,
      ...metadata,
    });
  }

  private recordReadRoute(route: LiveStoreReadRoute, source: LiveStoreReadSource): void {
    this.metrics.routeReadCounts[route][source] += 1;
  }

  private recordFallback(route: LiveStoreReadRoute, reason: LiveStoreFallbackReason): void {
    this.metrics.fallbackCounts[route][reason] += 1;
  }

  getAppSettings(): AppSettings {
    return this.delegate.getAppSettings();
  }

  updateAppSettings(raw: AppSettingsUpdateInput): AppSettings {
    return this.delegate.updateAppSettings(raw);
  }

  createThread(raw: ThreadsCreateInput): ThreadsUpdateResult {
    return this.delegate.createThread(raw);
  }

  updateThreadTerminalState(raw: ThreadsUpdateTerminalStateInput): ThreadsUpdateResult {
    return this.delegate.updateThreadTerminalState(raw);
  }

  updateThreadModel(raw: ThreadsUpdateModelInput): ThreadsUpdateResult {
    return this.delegate.updateThreadModel(raw);
  }

  updateThreadTitle(raw: ThreadsUpdateTitleInput): ThreadsUpdateResult {
    return this.delegate.updateThreadTitle(raw);
  }

  updateThreadBranch(raw: ThreadsUpdateBranchInput): ThreadsUpdateResult {
    return this.delegate.updateThreadBranch(raw);
  }

  markThreadVisited(raw: ThreadsMarkVisitedInput): ThreadsUpdateResult {
    return this.delegate.markThreadVisited(raw);
  }

  deleteThread(raw: ThreadsDeleteInput): void {
    this.delegate.deleteThread(raw);
  }

  listProjects(): ProjectListResult {
    return this.delegate.listProjects();
  }

  addProject(raw: ProjectAddInput): ProjectAddResult {
    return this.delegate.addProject(raw);
  }

  removeProject(raw: ProjectRemoveInput): void {
    this.delegate.removeProject(raw);
  }

  updateProjectScripts(raw: ProjectUpdateScriptsInput): ProjectUpdateScriptsResult {
    return this.delegate.updateProjectScripts(raw);
  }

  applyCheckpointRevert(input: ApplyCheckpointRevertInput): void {
    this.delegate.applyCheckpointRevert(input);
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.logger.info("livestore read pilot metrics", { metrics: this.metrics });
    this.unsubscribeDelegate();
    this.removeAllListeners();
    void this.mirror.dispose();
  }
}
