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

  it("surfaces the containing row title as context for repeated controls", async () => {
    // Occurrence order alone is not enough to pick the intended thread; the
    // visible row title must reach the model as disambiguation context.
    document.body.innerHTML = `
      <ul>
        <li><span>Fix login bug</span><button aria-label="Settle thread"></button></li>
        <li><span>Fix signup bug</span><button aria-label="Settle thread"></button></li>
      </ul>
    `;
    const output = await controls().listControls({});
    expect(output.controls.map((control) => control.context)).toEqual([
      "Fix login bug",
      "Fix signup bug",
    ]);
    const host = controls();
    const loginRowId = (await host.listControls({})).controls[0]!.controlId;
    expect(await host.clickControl({ controlId: loginRowId })).toMatchObject({
      state: "activated",
      name: "Settle thread",
    });
  });

  it("marks controls inside a disabled fieldset disabled, honoring the legend exception", async () => {
    document.body.innerHTML = `
      <fieldset disabled>
        <legend><button id="exempt">Legend action</button></legend>
        <button id="blocked">Retry</button>
      </fieldset>
      <fieldset disabled><legend>Options</legend><button id="inner">Inner</button></fieldset>
    `;
    const output = await controls().listControls({});
    const states = new Map(output.controls.map((control) => [control.name, control.state]));
    expect(states.get("Retry")).toBe("disabled");
    expect(states.get("Legend action")).toBe("enabled");
    // A first legend that merely labels the fieldset does not exempt
    // controls that follow it.
    expect(states.get("Inner")).toBe("disabled");

    const host = controls();
    const listed = await host.listControls({});
    const blockedId = listed.controls.find((control) => control.name === "Retry")!.controlId;
    const events: string[] = [];
    document.getElementById("blocked")!.addEventListener("click", () => events.push("click"));
    expect(await host.clickControl({ controlId: blockedId })).toMatchObject({
      state: "disabled",
      name: "Retry",
    });
    expect(events).toEqual([]);
  });

  it("treats controls under an inert ancestor as hidden and refuses them", async () => {
    document.body.innerHTML = `
      <div inert><button id="background">Background action</button></div>
      <button id="dialog">Dialog action</button>
    `;
    const output = await controls().listControls({});
    expect(output.controls.map((control) => control.name)).toEqual(["Dialog action"]);
    const withHidden = await controls().listControls({ includeHidden: true });
    expect(withHidden.controls.map((control) => [control.name, control.state])).toEqual([
      ["Background action", "hidden"],
      ["Dialog action", "enabled"],
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

  it("refuses a recycled row element whose visible context changed, until relisted", async () => {
    // A virtualized list can reuse the same row element for a different
    // thread. The listed id must not settle the new thread under the old
    // listing's intent, and a relist must make the element clickable again.
    document.body.innerHTML = `
      <li><span>Fix login bug</span><button aria-label="Settle thread" id="row"></button></li>
    `;
    const host = controls();
    const listedId = (await host.listControls({})).controls[0]!.controlId;

    const clicks: string[] = [];
    document.getElementById("row")!.addEventListener("click", () => clicks.push("clicked"));

    document.querySelector("span")!.textContent = "Fix signup bug";

    expect(await host.clickControl({ controlId: listedId })).toMatchObject({
      state: "not_found",
    });
    expect(clicks).toEqual([]);

    const relisted = await host.listControls({});
    expect(relisted.controls.map((control) => control.controlId)).toEqual([listedId]);
    expect(relisted.controls[0]!.context).toBe("Fix signup bug");
    expect(await host.clickControl({ controlId: listedId })).toMatchObject({
      state: "activated",
    });
    expect(clicks).toEqual(["clicked"]);
  });

  it("keeps context exact across numeric title changes", async () => {
    // "Task 123" -> "Task 124" is a different target even though the name
    // and the element are unchanged; the click must refuse, never retarget.
    document.body.innerHTML = `
      <li><span>Task 123</span><button aria-label="Settle thread" id="row"></button></li>
    `;
    const host = controls();
    const listedId = (await host.listControls({})).controls[0]!.controlId;
    expect((await host.listControls({})).controls[0]!.context).toBe("Task 123");

    const clicks: string[] = [];
    document.getElementById("row")!.addEventListener("click", () => clicks.push("clicked"));

    document.querySelector("span")!.textContent = "Task 124";

    expect(await host.clickControl({ controlId: listedId })).toMatchObject({
      state: "not_found",
    });
    expect(clicks).toEqual([]);
  });

  it("ignores structurally identified time and visually hidden text in context", async () => {
    // Relative timestamps and ticking durations are volatility, not
    // identity: they are excluded because they are structurally marked
    // (`<time>`/`[datetime]`/`aria-hidden`), so a click right after a
    // listing is never refused just because a clock advanced. Any other
    // context change still refuses.
    document.body.innerHTML = `
      <li>
        <span>Fix login bug</span>
        <time datetime="2026-09-15T00:00:00Z" id="tick">2m</time>
        <span aria-hidden="true" id="duration">00:42</span>
        <button aria-label="Settle thread" id="row"></button>
      </li>
    `;
    const host = controls();
    const listed = await host.listControls({});
    expect(listed.controls[0]!.context).toBe("Fix login bug");
    const listedId = listed.controls[0]!.controlId;

    const clicks: string[] = [];
    document.getElementById("row")!.addEventListener("click", () => clicks.push("clicked"));

    document.getElementById("tick")!.textContent = "3m";
    document.getElementById("duration")!.textContent = "00:43";

    expect(await host.clickControl({ controlId: listedId })).toMatchObject({
      state: "activated",
    });
    expect(clicks).toEqual(["clicked"]);
  });
});
