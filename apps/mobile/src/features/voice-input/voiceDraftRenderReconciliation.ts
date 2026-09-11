type Selection = {
  readonly start: number;
  readonly end: number;
};

export type VoiceDraftRenderSnapshot = {
  readonly ownerKey: string | null;
  readonly text: string;
  readonly selection: Selection;
};

function sameDraft(left: VoiceDraftRenderSnapshot, right: VoiceDraftRenderSnapshot): boolean {
  return left.ownerKey === right.ownerKey && left.text === right.text;
}

function sameSelection(left: Selection, right: Selection): boolean {
  return left.start === right.start && left.end === right.end;
}

export function reconcileVoiceDraftRender(
  rendered: VoiceDraftRenderSnapshot,
  current: VoiceDraftRenderSnapshot,
  incoming: VoiceDraftRenderSnapshot,
  acknowledged: readonly VoiceDraftRenderSnapshot[],
): {
  readonly current: VoiceDraftRenderSnapshot;
  readonly externalDraftChange: boolean;
  readonly consumedAcknowledgements: number;
} {
  if (!sameDraft(rendered, incoming)) {
    const acknowledgedIndex = acknowledged.findIndex((snapshot) => sameDraft(snapshot, incoming));
    if (!sameDraft(current, incoming) && acknowledgedIndex === -1) {
      return {
        current: incoming,
        externalDraftChange: true,
        consumedAcknowledgements: acknowledged.length,
      };
    }
    if (!sameDraft(current, incoming)) {
      return {
        current,
        externalDraftChange: false,
        consumedAcknowledgements: acknowledgedIndex + 1,
      };
    }
    return {
      current: {
        ...incoming,
        selection: sameSelection(rendered.selection, incoming.selection)
          ? current.selection
          : incoming.selection,
      },
      externalDraftChange: false,
      consumedAcknowledgements: acknowledgedIndex + 1,
    };
  }

  return {
    current: {
      ...current,
      selection: sameSelection(rendered.selection, incoming.selection)
        ? current.selection
        : incoming.selection,
    },
    externalDraftChange: false,
    consumedAcknowledgements: 0,
  };
}
