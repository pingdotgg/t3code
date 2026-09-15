import { describe, expect, it } from "vite-plus/test";
import type { VoiceUiControlRole, VoiceUiControlState } from "@t3tools/contracts";

import {
  createControlIdRegistry,
  listControlCandidates,
  resolveAndActivateControl,
  type VoiceControlCandidate,
} from "./domControls";

function candidate(
  role: VoiceUiControlRole,
  name: string,
  state: VoiceUiControlState = "enabled",
  activations: string[] = [],
  context?: string,
): VoiceControlCandidate<{ tag: string }> {
  const element = { tag: `${role}:${name}` };
  return {
    element,
    role,
    name,
    ...(context !== undefined ? { context } : {}),
    state,
    activate: () => {
      activations.push(element.tag);
    },
  };
}

describe("control id registry", () => {
  it("assigns one element the same id across listings", () => {
    const registry = createControlIdRegistry<{ tag: string }>();
    const element = { tag: "button" };
    const first = registry.idFor(element);
    expect(registry.idFor(element)).toBe(first);
    expect(registry.idFor({ tag: "button" })).not.toBe(first);
  });

  it("re-resolves a listed id to exactly its element", () => {
    const registry = createControlIdRegistry<{ tag: string }>();
    const element = { tag: "button" };
    const id = registry.idFor(element);
    expect(registry.elementOf(id)).toBe(element);
  });

  it("generates opaque ids that carry no target description", () => {
    const registry = createControlIdRegistry<{ tag: string }>();
    const id = registry.idFor({ tag: "button" });
    expect(id).toMatch(/^ctl-\d+$/);
  });
});

describe("listControlCandidates", () => {
  it("lists controls in order with per-element ids and occurrence context", () => {
    const registry = createControlIdRegistry<{ tag: string }>();
    const first = candidate("button", "Settle thread");
    const second = candidate("button", "Settle thread");
    const output = listControlCandidates([first, second], {}, registry);
    expect(output.controls).toEqual([
      {
        controlId: registry.idFor(first.element),
        role: "button",
        name: "Settle thread",
        state: "enabled",
        occurrence: 1,
        ambiguous: true,
      },
      {
        controlId: registry.idFor(second.element),
        role: "button",
        name: "Settle thread",
        state: "enabled",
        occurrence: 2,
        ambiguous: true,
      },
    ]);
    expect(output.truncated).toBeUndefined();
  });

  it("keeps occurrence context stable when filtering hides earlier duplicates", () => {
    const registry = createControlIdRegistry<{ tag: string }>();
    const hidden = candidate("button", "Settle thread", "hidden");
    const visible = candidate("button", "Settle thread");
    const output = listControlCandidates([hidden, visible], {}, registry);
    expect(output.controls).toEqual([
      {
        controlId: registry.idFor(visible.element),
        role: "button",
        name: "Settle thread",
        state: "enabled",
        occurrence: 2,
        ambiguous: true,
      },
    ]);
  });

  it("reports the visible container context that distinguishes repeated controls", () => {
    // Occurrence order alone cannot tell the model which thread a repeated
    // "Settle thread" button belongs to; the containing row's title can.
    const registry = createControlIdRegistry<{ tag: string }>();
    const loginRow = candidate("button", "Settle thread", "enabled", [], "Fix login bug");
    const signupRow = candidate("button", "Settle thread", "enabled", [], "Fix signup bug");
    const output = listControlCandidates([loginRow, signupRow], {}, registry);
    expect(output.controls.map((control) => control.context)).toEqual([
      "Fix login bug",
      "Fix signup bug",
    ]);
    expect(output.controls.map((control) => control.ambiguous)).toEqual([true, true]);
  });

  it("omits the context field when no container adds context", () => {
    const registry = createControlIdRegistry<{ tag: string }>();
    const output = listControlCandidates([candidate("button", "Save")], {}, registry);
    expect(output.controls[0]).not.toHaveProperty("context");
  });

  it("keeps a surviving element's id stable across relistings", () => {
    const registry = createControlIdRegistry<{ tag: string }>();
    const element = candidate("button", "Save").element;
    const firstId = listControlCandidates(
      [{ element, role: "button", name: "Save", state: "enabled", activate: () => {} }],
      {},
      registry,
    ).controls[0]?.controlId;
    const secondId = listControlCandidates(
      [{ element, role: "button", name: "Save", state: "enabled", activate: () => {} }],
      {},
      registry,
    ).controls[0]?.controlId;
    expect(firstId).toBe(secondId);
  });

  it("excludes hidden controls unless requested, and always marks disabled", () => {
    const registry = createControlIdRegistry<{ tag: string }>();
    const candidates = [
      candidate("button", "Run"),
      candidate("button", "Archived", "hidden"),
      candidate("button", "Retry", "disabled"),
    ];
    expect(listControlCandidates(candidates, {}, registry).controls.map((c) => c.state)).toEqual([
      "enabled",
      "disabled",
    ]);
    expect(
      listControlCandidates(candidates, { includeHidden: true }, registry).controls.map(
        (c) => c.name,
      ),
    ).toEqual(["Run", "Archived", "Retry"]);
  });

  it("filters by case-insensitive name substring", () => {
    const registry = createControlIdRegistry<{ tag: string }>();
    const candidates = [candidate("button", "New thread"), candidate("link", "Documentation")];
    const output = listControlCandidates(candidates, { query: "THREAD" }, registry);
    expect(output.controls).toHaveLength(1);
    expect(output.controls[0]?.name).toBe("New thread");
  });

  it("applies the limit and reports truncation", () => {
    const registry = createControlIdRegistry<{ tag: string }>();
    const candidates = [
      candidate("button", "One"),
      candidate("button", "Two"),
      candidate("button", "Three"),
    ];
    const output = listControlCandidates(candidates, { limit: 2 }, registry);
    expect(output.controls).toHaveLength(2);
    expect(output.truncated).toBe(true);
    expect(listControlCandidates(candidates, { limit: 3 }, registry).truncated).toBeUndefined();
  });
});

describe("resolveAndActivateControl", () => {
  it("activates the element the id was assigned to", () => {
    const registry = createControlIdRegistry<{ tag: string }>();
    const activations: string[] = [];
    const target = candidate("button", "Delete", "enabled", activations);
    const id = listControlCandidates([target], {}, registry).controls[0]!.controlId;
    expect(resolveAndActivateControl([target], registry, { controlId: id })).toEqual({
      state: "activated",
      role: "button",
      name: "Delete",
    });
    expect(activations).toEqual(["button:Delete"]);
  });

  it("never retargets a surviving same-named sibling after one duplicate is removed", () => {
    // Two "Settle thread" buttons are listed, then the first is removed from
    // the live UI. The old id must be rejected as stale, never fall through
    // to the second button, which would settle the WRONG thread.
    const registry = createControlIdRegistry<{ tag: string }>();
    const activations: string[] = [];
    const first = candidate("button", "Settle thread", "enabled", activations);
    const second = candidate("button", "Settle thread", "enabled", activations);
    const listed = listControlCandidates([first, second], {}, registry).controls;
    const removedId = listed[0]!.controlId;

    const resolution = resolveAndActivateControl([second], registry, { controlId: removedId });

    expect(resolution).toMatchObject({ state: "not_found" });
    if (resolution.state !== "activated") {
      expect(resolution.message).toContain("stale");
    }
    expect(activations).toEqual([]);
  });

  it("keeps the survivor addressable by its own id after the removal", () => {
    const registry = createControlIdRegistry<{ tag: string }>();
    const activations: string[] = [];
    const first = candidate("button", "Settle thread", "enabled", activations);
    const second = candidate("button", "Settle thread", "enabled", activations);
    const listed = listControlCandidates([first, second], {}, registry).controls;
    const survivorId = listed[1]!.controlId;

    const resolution = resolveAndActivateControl([second], registry, { controlId: survivorId });

    expect(resolution.state).toBe("activated");
    expect(activations).toEqual(["button:Settle thread"]);
  });

  it("rejects ids the session never listed", () => {
    const registry = createControlIdRegistry<{ tag: string }>();
    const activations: string[] = [];
    const target = candidate("button", "Run", "enabled", activations);
    expect(resolveAndActivateControl([target], registry, { controlId: "ctl-999" }).state).toBe(
      "not_found",
    );
    expect(resolveAndActivateControl([target], registry, { controlId: "button#1:Run" }).state).toBe(
      "not_found",
    );
    expect(resolveAndActivateControl([target], registry, { controlId: "" }).state).toBe(
      "not_found",
    );
    expect(activations).toEqual([]);
  });

  it("refuses disabled and hidden targets without activating", () => {
    const registry = createControlIdRegistry<{ tag: string }>();
    const activations: string[] = [];
    const disabled = candidate("button", "Retry", "disabled", activations);
    const hidden = candidate("menuitem", "Duplicate", "hidden", activations);
    const listed = listControlCandidates([disabled, hidden], { includeHidden: true }, registry);
    const disabledId = listed.controls[0]!.controlId;
    const hiddenId = listed.controls[1]!.controlId;

    expect(
      resolveAndActivateControl([disabled, hidden], registry, { controlId: disabledId }),
    ).toMatchObject({ state: "disabled" });
    expect(
      resolveAndActivateControl([disabled, hidden], registry, { controlId: hiddenId }),
    ).toMatchObject({ state: "hidden" });
    expect(activations).toEqual([]);
  });

  it("refuses a listed control whose accessible name changed since listing", () => {
    // Element identity survives virtual-list reuse: the same DOM element may
    // now be a different button. The listed name no longer describes what a
    // click would do, so the id must be refused, never activated.
    const registry = createControlIdRegistry<{ tag: string }>();
    const activations: string[] = [];
    const element = candidate("button", "Settle thread", "enabled", activations).element;
    const id = listControlCandidates(
      [{ element, role: "button", name: "Settle thread", state: "enabled", activate: () => {} }],
      {},
      registry,
    ).controls[0]!.controlId;

    const resolution = resolveAndActivateControl(
      [{ element, role: "button", name: "Archive thread", state: "enabled", activate: () => {} }],
      registry,
      { controlId: id },
    );

    expect(resolution).toMatchObject({ state: "not_found" });
    if (resolution.state !== "activated") {
      expect(resolution.message).toContain("now reads");
    }
    expect(activations).toEqual([]);
  });

  it("refuses a listed control whose visible context changed since listing", () => {
    // A recycled row keeps the same "Settle thread" element but now titles a
    // different thread; clicking the old id must not settle the wrong thread.
    const registry = createControlIdRegistry<{ tag: string }>();
    const activations: string[] = [];
    const element = candidate(
      "button",
      "Settle thread",
      "enabled",
      activations,
      "Fix login bug",
    ).element;
    const id = listControlCandidates(
      [
        {
          element,
          role: "button",
          name: "Settle thread",
          context: "Fix login bug",
          state: "enabled",
          activate: () => {},
        },
      ],
      {},
      registry,
    ).controls[0]!.controlId;

    const resolution = resolveAndActivateControl(
      [
        {
          element,
          role: "button",
          name: "Settle thread",
          context: "Fix signup bug",
          state: "enabled",
          activate: () => {},
        },
      ],
      registry,
      { controlId: id },
    );

    expect(resolution).toMatchObject({ state: "not_found" });
    expect(activations).toEqual([]);
  });

  it("refuses a recycled row whose title differs only numerically", () => {
    // Context comparison is exact: "Phase 3.1" and "Phase 3.2" are different
    // targets even though the name and the element are the same, so clicking
    // the old id must refuse instead of activating the wrong row.
    const registry = createControlIdRegistry<{ tag: string }>();
    const activations: string[] = [];
    const element = candidate(
      "button",
      "Settle thread",
      "enabled",
      activations,
      "Phase 3.1",
    ).element;
    const id = listControlCandidates(
      [
        {
          element,
          role: "button",
          name: "Settle thread",
          context: "Phase 3.1",
          state: "enabled",
          activate: () => {},
        },
      ],
      {},
      registry,
    ).controls[0]!.controlId;

    const resolution = resolveAndActivateControl(
      [
        {
          element,
          role: "button",
          name: "Settle thread",
          context: "Phase 3.2",
          state: "enabled",
          activate: () => {},
        },
      ],
      registry,
      { controlId: id },
    );

    expect(resolution).toMatchObject({ state: "not_found" });
    expect(activations).toEqual([]);
  });

  it("keeps context exact across the board (no digit normalization)", () => {
    // Task 123 and Task 124 are different threads; a context comparison that
    // ignored digits would retarget between them.
    const registry = createControlIdRegistry<{ tag: string }>();
    const activations: string[] = [];
    const element = candidate(
      "button",
      "Settle thread",
      "enabled",
      activations,
      "Task 123",
    ).element;
    const id = listControlCandidates(
      [
        {
          element,
          role: "button",
          name: "Settle thread",
          context: "Task 123",
          state: "enabled",
          activate: () => {},
        },
      ],
      {},
      registry,
    ).controls[0]!.controlId;

    expect(
      resolveAndActivateControl(
        [
          {
            element,
            role: "button",
            name: "Settle thread",
            context: "Task 124",
            state: "enabled",
            activate: () => {},
          },
        ],
        registry,
        { controlId: id },
      ),
    ).toMatchObject({ state: "not_found" });
    expect(activations).toEqual([]);
  });
});
