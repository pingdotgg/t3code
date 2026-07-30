import {
  VoiceBudRecordingStartedEvent,
  VoiceBudTranscriptionEvent,
  VoiceBudDraftId,
  type ScopedThreadRef,
  type VoiceBudDraftTarget,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useEffect, useLayoutEffect } from "react";

import { DraftId, type DraftId as DraftIdType, useComposerDraftStore } from "./composerDraftStore";
import { readThreadShell, readThreadStatus } from "./state/entities";

type ComposerTarget = ScopedThreadRef | DraftIdType;

let activeTarget: ComposerTarget | null = null;
const isVoiceBudRecordingStartedEvent = Schema.is(VoiceBudRecordingStartedEvent);
const isVoiceBudTranscriptionEvent = Schema.is(VoiceBudTranscriptionEvent);

function toVoiceBudTarget(target: ComposerTarget): VoiceBudDraftTarget {
  return typeof target === "string"
    ? { _tag: "Draft", draftId: VoiceBudDraftId.make(target) }
    : {
        _tag: "Thread",
        environmentId: target.environmentId,
        threadId: target.threadId,
      };
}

function toComposerTarget(target: VoiceBudDraftTarget): ComposerTarget {
  return target._tag === "Draft"
    ? DraftId.make(target.draftId)
    : {
        environmentId: target.environmentId,
        threadId: target.threadId,
      };
}

export function applyVoiceBudTranscription(
  event: VoiceBudTranscriptionEvent,
  threadExists: (threadRef: ScopedThreadRef) => boolean = (threadRef) =>
    readThreadShell(threadRef) !== null && readThreadStatus(threadRef) !== "deleted",
): boolean {
  const target = toComposerTarget(event.target);
  if (typeof target !== "string" && !threadExists(target)) {
    return false;
  }
  return useComposerDraftStore.getState().appendPrompt(target, event.transcript);
}

/**
 * Tracks the route's stable composer identity. The external VoiceBud process
 * can only announce a recording id; it never supplies this destination.
 */
export function useVoiceBudDraftTarget(target: ComposerTarget): void {
  useLayoutEffect(() => {
    activeTarget = target;
    return () => {
      if (activeTarget === target) {
        activeTarget = null;
      }
    };
  }, [target]);
}

export function VoiceBudDraftBridgeConsumer() {
  useEffect(() => {
    const bridge = window.desktopBridge?.voiceBud;
    if (!bridge) return;

    const unsubscribeStarted = bridge.onRecordingStarted((event) => {
      if (!isVoiceBudRecordingStartedEvent(event)) return;
      const target = activeTarget;
      if (!target) return;
      void bridge
        .bindRecording({
          requestId: event.requestId,
          recordingId: event.recordingId,
          target: toVoiceBudTarget(target),
        })
        .catch(() => undefined);
    });

    const unsubscribeTranscription = bridge.onTranscription((event) => {
      if (!isVoiceBudTranscriptionEvent(event)) return;
      const applied = applyVoiceBudTranscription(event);
      void bridge
        .acknowledgeDelivery({
          deliveryId: event.deliveryId,
          applied,
        })
        .catch(() => undefined);
    });

    return () => {
      unsubscribeStarted();
      unsubscribeTranscription();
    };
  }, []);

  return null;
}
