// @vitest-environment jsdom
/**
 * Real-DOM tests for the voice control adapter: accessible-name derivation,
 * role derivation, the activation event sequence, native activation default
 * actions, and stale-id revalidation against a live document. jsdom has no
 * layout engine, so getClientRects is patched per element to model
 * visibility; everything else (selectors, events, activation behavior) is
 * real.
 */
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { createDomVoiceControlHost } from "./domControls";

// jsdom has no PointerEvent; the adapter falls back when it is missing, so a
// minimal stand-in is defined to exercise the full pointer sequence.
class TestPointerEvent extends MouseEvent {
  readonly pointerId: number;
  readonly isPrimary: boolean;
  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 0;
    this.isPrimary = init.isPrimary ?? false;
  }
}

const showHidden = (element: Element) => {
  Object.defineProperty(element, "getClientRects", {
    value: () => [],
    configurable: true,
  });
};

const controls = () => createDomVoiceControlHost();

const listNames = async (input?: Parameters<ReturnType<typeof controls>["listControls"]>[0]) =>
  (await controls().listControls(input ?? {})).controls.map((control) => control.name);

beforeEach(() => {
  document.body.innerHTML = "";
  (window as unknown as { PointerEvent: unknown }).PointerEvent = TestPointerEvent;
  Object.defineProperty(Element.prototype, "getClientRects", {
    value: () => [{ width: 10, height: 10 }],
    configurable: true,
  });
});

describe("dom adapter: accessible names", () => {
  it("derives names from aria-label, content, input values and title", async () => {
    document.body.innerHTML = `
      <button id="labelled" aria-labelledby="label-source"></button>
      <span id="label-source">Export thread</span>
      <button aria-label="Archive">Ignore me</button>
      <button>Compose</button>
      <input type="submit" />
      <input type="button" value="Apply now" />
      <a href="/docs">Documentation</a>
      <span role="button" title="Toggle sidebar"></span>
    `;
    expect(await listNames()).toEqual([
      "Export thread",
      "Archive",
      "Compose",
      "Submit",
      "Apply now",
      "Documentation",
      "Toggle sidebar",
    ]);
  });

  it("collapses whitespace in content names", async () => {
    document.body.innerHTML = `<button>  New
      thread  </button>`;
    expect(await listNames()).toEqual(["New thread"]);
  });
});

describe("dom adapter: roles and states", () => {
  it("derives roles from tags, input types and explicit role attributes", async () => {
    document.body.innerHTML = `
      <button>Go</button>
      <a href="/x">Doc</a>
      <input type="checkbox" />
      <input type="radio" />
      <div role="tab">Overview</div>
      <div role="menuitem">Duplicate</div>
      <div role="textbox">Not a supported control</div>
      <span>Plain text is not a control</span>
    `;
    const output = await controls().listControls({});
    // Exactly the six supported controls are listed; the textbox-role div
    // and the plain span are unsupported and absent.
    expect(output.controls.map((control) => `${control.role}:${control.name}`).sort()).toEqual(
      ["button:Go", "checkbox:", "link:Doc", "menuitem:Duplicate", "radio:", "tab:Overview"].sort(),
    );
  });

  it("marks disabled and hidden controls and applies the filters", async () => {
    document.body.innerHTML = `
      <button>Run</button>
      <button disabled>Retry</button>
      <button aria-disabled="true">Undo</button>
      <button id="ghost" aria-hidden="true">Ghost</button>
      <button id="gone">Offscreen</button>
    `;
    showHidden(document.getElementById("ghost")!);
    showHidden(document.getElementById("gone")!);
    const output = await controls().listControls({});
    expect(output.controls.map((control) => [control.name, control.state])).toEqual([
      ["Run", "enabled"],
      ["Retry", "disabled"],
      ["Undo", "disabled"],
    ]);
    const withHidden = await controls().listControls({ includeHidden: true });
    expect(withHidden.controls.map((control) => [control.name, control.state])).toEqual([
      ["Run", "enabled"],
      ["Retry", "disabled"],
      ["Undo", "disabled"],
      ["Ghost", "hidden"],
      ["Offscreen", "hidden"],
    ]);
  });

  it("marks same-named controls ambiguous with occurrence context", async () => {
    document.body.innerHTML = `
      <button>Settle thread</button>
      <button>Settle thread</button>
    `;
    const output = await controls().listControls({});
    expect(output.controls.map((control) => [control.occurrence, control.ambiguous])).toEqual([
      [1, true],
      [2, true],
    ]);
  });
});

describe("dom adapter: activation", () => {
  it("dispatches the full pointer and click sequence at the element center", async () => {
    document.body.innerHTML = `<button id="target">Launch</button>`;
    const button = document.getElementById("target")!;
    const seen: { type: string; bubbles: boolean; composed: boolean; button: number }[] = [];
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
      button.addEventListener(type, (event) => {
        seen.push({
          type,
          bubbles: event.bubbles,
          composed: event.composed,
          button: (event as MouseEvent).button,
        });
      });
    }
    const host = controls();
    const listed = await host.listControls({});
    const result = await host.clickControl({ controlId: listed.controls[0]!.controlId });

    expect(result).toMatchObject({ state: "activated", name: "Launch", role: "button" });
    expect(seen.map((event) => event.type)).toEqual([
      "pointerdown",
      "mousedown",
      "pointerup",
      "mouseup",
      "click",
    ]);
    for (const event of seen) {
      expect(event.bubbles).toBe(true);
      expect(event.composed).toBe(true);
      expect(event.button).toBe(0);
    }
  });

  it("runs native activation default actions (checkbox toggle, option selection)", async () => {
    document.body.innerHTML = `
      <input type="checkbox" id="opt-in" />
      <select id="model"><option>fast</option><option id="slow">slow</option></select>
    `;
    const host = controls();
    const listed = await host.listControls({});
    const byName = new Map(
      listed.controls.map((control) => [control.role + ":" + control.name, control.controlId]),
    );
    await host.clickControl({ controlId: byName.get("checkbox:")! });
    expect((document.getElementById("opt-in") as HTMLInputElement).checked).toBe(true);

    await host.clickControl({ controlId: byName.get("option:slow")! });
    const select = document.getElementById("model") as HTMLSelectElement;
    expect(select.value).toBe("slow");
    expect((document.getElementById("slow") as HTMLOptionElement).selected).toBe(true);
  });

  it("refuses a disabled control without dispatching any events", async () => {
    document.body.innerHTML = `<button disabled id="blocked">Retry</button>`;
    const button = document.getElementById("blocked")!;
    const events: string[] = [];
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
      button.addEventListener(type, () => events.push(type));
    }
    const host = controls();
    const listed = await host.listControls({});
    expect(await host.clickControl({ controlId: listed.controls[0]!.controlId })).toMatchObject({
      state: "disabled",
      name: "Retry",
    });
    expect(events).toEqual([]);
  });

  it("rejects a stale id after its element is removed instead of clicking the sibling", async () => {
    document.body.innerHTML = `
      <button id="first">Settle thread</button>
      <button id="second">Settle thread</button>
    `;
    const host = controls();
    const listed = await host.listControls({});
    expect(listed.controls).toHaveLength(2);
    const removedId = listed.controls[0]!.controlId;
    const survivorId = listed.controls[1]!.controlId;

    document.getElementById("first")!.remove();

    const secondButton = document.getElementById("second")!;
    const clicks: string[] = [];
    secondButton.addEventListener("click", () => clicks.push("clicked"));

    expect(await host.clickControl({ controlId: removedId })).toMatchObject({
      state: "not_found",
    });
    expect(clicks).toEqual([]);

    // The survivor keeps its own id and stays clickable; a relist returns it.
    expect(await host.clickControl({ controlId: survivorId })).toMatchObject({
      state: "activated",
    });
    expect(clicks).toEqual(["clicked"]);
    const relisted = await host.listControls({});
    expect(relisted.controls.map((control) => control.controlId)).toEqual([survivorId]);
  });

  it("rejects a fabricated id that was never listed", async () => {
    document.body.innerHTML = `<button>Run</button>`;
    const result = await controls().clickControl({ controlId: "ctl-404" });
    expect(result.state).toBe("not_found");
  });
});
