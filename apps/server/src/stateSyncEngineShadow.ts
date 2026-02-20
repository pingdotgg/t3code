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
import { diffCatchUpResults, diffListMessagesResults, diffStateSnapshots } from "./livestore/parity";
import type { ApplyCheckpointRevertInput, StateSyncEngine } from "./stateSyncEngine";

interface StateSyncEngineShadowEvents {
  stateEvent: [event: StateEvent];
}

export interface StateEventMirror {
  mirrorStateEvent(event: StateEvent): Promise<void | boolean>;
  debugReadSnapshot?(): StateBootstrapResult;
  debugCatchUp?(afterSeq: number): StateCatchUpResult;
  debugListMessages?(raw: StateListMessagesInput): StateListMessagesResult;
  dispose(): Promise<void> | void;
}

export interface ShadowStateSyncEngineOptions {
  delegate: StateSyncEngine;
  mirror: StateEventMirror;
  enableBootstrapParityCheck?: boolean;
  enableCatchUpParityCheck?: boolean;
  enableListMessagesParityCheck?: boolean;
}

export class ShadowStateSyncEngine
  extends EventEmitter<StateSyncEngineShadowEvents>
  implements StateSyncEngine
{
  private readonly delegate: StateSyncEngine;
  private readonly mirror: StateEventMirror;
  private readonly enableBootstrapParityCheck: boolean;
  private readonly enableCatchUpParityCheck: boolean;
  private readonly enableListMessagesParityCheck: boolean;
  private readonly logger = createLogger("shadow-sync-engine");
  private readonly unsubscribeDelegate: () => void;
  private closed = false;
  private bootstrapParityState: "unknown" | "in-parity" | "drift" = "unknown";
  private catchUpParityState: "unknown" | "in-parity" | "drift" = "unknown";
  private listMessagesParityState: "unknown" | "in-parity" | "drift" = "unknown";

  constructor(options: ShadowStateSyncEngineOptions) {
    super();
    this.delegate = options.delegate;
    this.mirror = options.mirror;
    this.enableBootstrapParityCheck = options.enableBootstrapParityCheck ?? false;
    this.enableCatchUpParityCheck = options.enableCatchUpParityCheck ?? false;
    this.enableListMessagesParityCheck = options.enableListMessagesParityCheck ?? false;
    this.unsubscribeDelegate = this.delegate.onStateEvent((event) => {
      this.emit("stateEvent", event);
      void this.mirror
        .mirrorStateEvent(event)
        .then((mirrored) => {
          if (mirrored === false) {
            this.logger.warn("livestore shadow mirror reported unsuccessful write", {
              seq: event.seq,
            });
          }
        })
        .catch((error) => {
          this.logger.warn("livestore shadow mirror failed", { error, seq: event.seq });
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
    const snapshot = this.delegate.loadSnapshot();
    if (this.enableBootstrapParityCheck) {
      this.checkBootstrapParity(snapshot);
    }
    return snapshot;
  }

  private checkBootstrapParity(delegateSnapshot: StateBootstrapResult): void {
    if (typeof this.mirror.debugReadSnapshot !== "function") {
      return;
    }

    let mirrorSnapshot: StateBootstrapResult;
    try {
      mirrorSnapshot = this.mirror.debugReadSnapshot();
    } catch (error) {
      this.logger.warn("shadow bootstrap parity check failed to read mirror snapshot", { error });
      return;
    }

    const diffs = diffStateSnapshots(delegateSnapshot, mirrorSnapshot);
    if (diffs.length === 0) {
      if (this.bootstrapParityState !== "in-parity") {
        this.bootstrapParityState = "in-parity";
        this.logger.info("shadow bootstrap parity check passed", {
          lastStateSeq: delegateSnapshot.lastStateSeq,
        });
      }
      return;
    }

    this.bootstrapParityState = "drift";
    this.logger.warn("shadow bootstrap parity drift detected", {
      diffCount: diffs.length,
      samplePaths: diffs.slice(0, 5).map((diff) => diff.path),
      delegateLastStateSeq: delegateSnapshot.lastStateSeq,
      mirrorLastStateSeq: mirrorSnapshot.lastStateSeq,
    });
  }

  listMessages(raw: StateListMessagesInput): StateListMessagesResult {
    const result = this.delegate.listMessages(raw);
    if (this.enableListMessagesParityCheck) {
      this.checkListMessagesParity(raw, result);
    }
    return result;
  }

  catchUp(raw: StateCatchUpInput): StateCatchUpResult {
    const result = this.delegate.catchUp(raw);
    if (this.enableCatchUpParityCheck) {
      this.checkCatchUpParity(raw, result);
    }
    return result;
  }

  private checkCatchUpParity(raw: StateCatchUpInput, delegateResult: StateCatchUpResult): void {
    if (typeof this.mirror.debugCatchUp !== "function") {
      return;
    }

    const afterSeq = raw.afterSeq ?? 0;
    let mirrorResult: StateCatchUpResult;
    try {
      mirrorResult = this.mirror.debugCatchUp(afterSeq);
    } catch (error) {
      this.logger.warn("shadow catch-up parity check failed to read mirror catch-up", { error });
      return;
    }

    const diffs = diffCatchUpResults(delegateResult, mirrorResult);
    if (diffs.length === 0) {
      if (this.catchUpParityState !== "in-parity") {
        this.catchUpParityState = "in-parity";
        this.logger.info("shadow catch-up parity check passed", {
          afterSeq,
          lastStateSeq: delegateResult.lastStateSeq,
        });
      }
      return;
    }

    this.catchUpParityState = "drift";
    this.logger.warn("shadow catch-up parity drift detected", {
      afterSeq,
      diffCount: diffs.length,
      sampleDiffs: diffs.slice(0, 5),
      delegateLastStateSeq: delegateResult.lastStateSeq,
      mirrorLastStateSeq: mirrorResult.lastStateSeq,
    });
  }

  private checkListMessagesParity(
    raw: StateListMessagesInput,
    delegateResult: StateListMessagesResult,
  ): void {
    if (typeof this.mirror.debugListMessages !== "function") {
      return;
    }

    let mirrorResult: StateListMessagesResult;
    try {
      mirrorResult = this.mirror.debugListMessages(raw);
    } catch (error) {
      this.logger.warn("shadow list-messages parity check failed to read mirror listMessages", {
        error,
      });
      return;
    }

    const diffs = diffListMessagesResults(delegateResult, mirrorResult);
    if (diffs.length === 0) {
      if (this.listMessagesParityState !== "in-parity") {
        this.listMessagesParityState = "in-parity";
        this.logger.info("shadow list-messages parity check passed", {
          threadId: raw.threadId,
          offset: raw.offset ?? 0,
          limit: raw.limit ?? 200,
        });
      }
      return;
    }

    this.listMessagesParityState = "drift";
    this.logger.warn("shadow list-messages parity drift detected", {
      threadId: raw.threadId,
      offset: raw.offset ?? 0,
      limit: raw.limit ?? 200,
      diffCount: diffs.length,
      sampleDiffs: diffs.slice(0, 5),
    });
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
    this.unsubscribeDelegate();
    this.removeAllListeners();
    void this.mirror.dispose();
  }
}
