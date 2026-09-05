import { describe, expect, it } from "vite-plus/test";

import {
  reconcileVoiceDraftRender,
  type VoiceDraftRenderSnapshot,
} from "./voiceDraftRenderReconciliation";

const rendered: VoiceDraftRenderSnapshot = {
  ownerKey: "environment:thread",
  text: "before",
  selection: { start: 6, end: 6 },
};

describe("reconcileVoiceDraftRender", () => {
  it("keeps an acknowledged hypothesis through stale unrelated renders and its parent echo", () => {
    const acknowledged: VoiceDraftRenderSnapshot = {
      ...rendered,
      text: "before spoken words",
      selection: { start: 19, end: 19 },
    };

    const staleRender = reconcileVoiceDraftRender(rendered, acknowledged, rendered, [acknowledged]);
    expect(staleRender).toEqual({
      current: acknowledged,
      externalDraftChange: false,
      consumedAcknowledgements: 0,
    });

    const selectionEcho = reconcileVoiceDraftRender(
      rendered,
      acknowledged,
      {
        ...rendered,
        selection: acknowledged.selection,
      },
      [acknowledged],
    );
    expect(selectionEcho).toEqual({
      current: acknowledged,
      externalDraftChange: false,
      consumedAcknowledgements: 0,
    });

    const draftEcho = reconcileVoiceDraftRender(
      rendered,
      acknowledged,
      {
        ...acknowledged,
        selection: rendered.selection,
      },
      [acknowledged],
    );
    expect(draftEcho).toEqual({
      current: acknowledged,
      externalDraftChange: false,
      consumedAcknowledgements: 1,
    });
  });

  it("does not mistake an older acknowledged hypothesis for an external edit", () => {
    const first = { ...rendered, text: "before one" };
    const second = { ...rendered, text: "before one two" };

    expect(reconcileVoiceDraftRender(rendered, second, first, [first, second])).toEqual({
      current: second,
      externalDraftChange: false,
      consumedAcknowledgements: 1,
    });
  });

  it("accepts a real external draft edit", () => {
    const reconciled = reconcileVoiceDraftRender(
      rendered,
      { ...rendered, text: "before spoken words" },
      {
        ...rendered,
        text: "manual edit",
        selection: { start: 11, end: 11 },
      },
      [{ ...rendered, text: "before spoken words" }],
    );

    expect(reconciled).toEqual({
      current: {
        ...rendered,
        text: "manual edit",
        selection: { start: 11, end: 11 },
      },
      externalDraftChange: true,
      consumedAcknowledgements: 1,
    });
  });
});
