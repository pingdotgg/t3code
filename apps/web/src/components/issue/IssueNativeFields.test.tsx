// @vitest-environment jsdom

import type { IssueFieldValues, IssueInputField, IssueState } from "@t3tools/contracts";
import { act, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { IssueNativeFields, nativeFieldError, nativeFieldValues } from "./IssueNativeFields";
import { IssueStateFieldsDialog } from "./IssueStateFieldsDialog";
import { IssueJsonField } from "./IssueJsonField";

const json = (required = false): IssueInputField => ({
  id: "payload",
  label: "Payload",
  kind: "json",
  required,
});
const cascade = (required = false): IssueInputField => ({
  id: "area",
  label: "Area",
  kind: "cascading-select",
  required,
  options: [
    {
      value: "10",
      label: "Hardware",
      children: [
        { value: "11", label: "Laptop" },
        { value: "12", label: "Phone" },
      ],
    },
    { value: "20", label: "Software" },
  ],
});

let root: Root;
let container: HTMLDivElement;
let latest: IssueFieldValues;
let reset: (values: IssueFieldValues) => void;

function Harness({
  fields,
  initial,
  disabled,
}: {
  fields: readonly IssueInputField[];
  initial: IssueFieldValues;
  disabled: boolean;
}) {
  const [values, setValues] = useState(initial);
  useEffect(() => {
    latest = values;
    reset = setValues;
  });
  return (
    <IssueNativeFields fields={fields} values={values} onChange={setValues} disabled={disabled} />
  );
}

const render = (
  fields: readonly IssueInputField[],
  initial: IssueFieldValues = {},
  disabled = false,
) =>
  act(async () => root.render(<Harness fields={fields} initial={initial} disabled={disabled} />));
const byLabel = <T extends HTMLElement>(label: string) => {
  const element = document.querySelector<T>(`[aria-label="${label}"]`);
  expect(element, label).not.toBeNull();
  return element!;
};
const button = (text: string) => {
  const found = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (entry) => entry.textContent === text,
  );
  expect(found, text).toBeDefined();
  return found!;
};
const click = (element: HTMLElement) => act(async () => element.click());
async function type(label: string, value: string) {
  const input = byLabel<HTMLInputElement | HTMLTextAreaElement>(label);
  const prototype =
    input instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function choose(label: string, title: string) {
  await act(async () =>
    byLabel(label).dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })),
  );
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].findLast(
    (entry) => entry.textContent === title,
  );
  expect(option, title).toBeDefined();
  await click(option!);
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("structured JSON field", () => {
  it("builds nested objects and lists with typed scalars without writing JSON", async () => {
    await render([json(true)]);
    expect(nativeFieldError([json(true)], latest)).toBe("Fill in Payload.");
    await choose("Payload type", "Object");
    await click(button("Add entry"));
    expect(nativeFieldError([json(true)], latest)).toBe("Enter every key in Payload.");
    await type("Payload key 1", "items");
    await choose("Payload › items type", "List");
    await click(button("0 items"));
    for (let index = 0; index < 4; index++) await click(button("Add item"));
    await choose("Payload › items › 1 type", "Number");
    await type("Payload › items › 1 value", "1.");
    expect(nativeFieldError([json(true)], latest)).toBe("Enter valid JSON for Payload.");
    expect(byLabel("Payload › items › 1 value").getAttribute("aria-invalid")).toBe("true");
    await type("Payload › items › 1 value", "-2.50");
    await choose("Payload › items › 2 type", "true");
    await choose("Payload › items › 3 type", "null");
    await type("Payload › items › 4 value", 'say "hi" \\ there');
    expect(latest.payload).toBe('{"items":[-2.50,true,null,"say \\"hi\\" \\\\ there"]}');
    expect(nativeFieldError([json(true)], latest)).toBeNull();
    expect(JSON.parse(nativeFieldValues([json(true)], latest).payload as string)).toEqual({
      items: [-2.5, true, null, 'say "hi" \\ there'],
    });
    await click(byLabel("Remove Payload › items › 3"));
    expect(latest.payload).toBe('{"items":[-2.50,true,"say \\"hi\\" \\\\ there"]}');
  });

  it("round-trips untouched values byte for byte apart from whitespace", async () => {
    const incoming = '{ "n": -0.50e+1, "s": "q\\"\\\\\\u2028", "x": null, "l": [false, {}] }';
    await render([json()], { payload: incoming });
    expect(latest.payload).toBe(incoming);
    await type("Payload › s value", "changed");
    expect(latest.payload).toBe('{"n":-0.50e+1,"s":"changed","x":null,"l":[false,{}]}');
  });

  it("keeps duplicate and prototype keys visible and blocks them", async () => {
    await render([json()], { payload: '{"a":1,"a":2}' });
    expect(nativeFieldError([json()], latest)).toBe('Remove the duplicate key "a" in Payload.');
    expect(byLabel<HTMLInputElement>("Payload key 2").value).toBe("a");
    expect(byLabel("Payload key 2").getAttribute("aria-invalid")).toBe("true");
    await type("Payload key 2", "b");
    expect(latest.payload).toBe('{"a":1,"b":2}');
    expect(nativeFieldError([json()], latest)).toBeNull();

    for (const key of ["__proto__", "constructor", "prototype"]) {
      const value = { payload: `{"${key}":{"polluted":true}}` };
      expect(nativeFieldError([json()], value)).toBe(`Rename the key "${key}" in Payload.`);
    }
    await act(async () => reset({ payload: '{"__proto__":{"polluted":true}}' }));
    expect(byLabel<HTMLInputElement>("Payload key 1").value).toBe("__proto__");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("enforces the JSON grammar, finite numbers, depth and size", () => {
    const error = (payload: string) => nativeFieldError([json()], { payload });
    for (const valid of [" [ ] ", "{ }", '"\\ud83d\\ude00"', "-0", "1E+2", "40", "null"])
      expect(error(valid), valid).toBeNull();
    for (const invalid of [
      "[1,]",
      '{"a":1,}',
      "01",
      "1.",
      ".5",
      "NaN",
      "'a'",
      '"\\x"',
      '"\t"',
      "[1] 2",
      "tru",
    ])
      expect(error(invalid), invalid).toBe("Enter valid JSON for Payload.");
    expect(error("1e400")).toBe("Enter a finite number in Payload.");
    expect(error(`${"[".repeat(41)}${"]".repeat(41)}`)).toBeNull();
    expect(error(`${"[".repeat(42)}${"]".repeat(42)}`)).toBe("Payload is nested too deeply.");
    expect(error(`${"[".repeat(41)}0${"]".repeat(41)}`)).toBe("Payload is nested too deeply.");
    expect(error(`["[[[",${"{".repeat(30_000)}`)).toBe("Payload is nested too deeply.");
    expect(error(`[${Array(20_000).fill(0).join(",")}]`)).toBe("Payload is too large.");
    expect(error(`"${"a".repeat(65_535)}"`)).toBe("Payload is too large.");
  });

  it("blocks invalid optional drafts and falls back to source for unparseable values", async () => {
    await render([json()], { payload: "{oops" });
    expect(nativeFieldError([json()], latest)).toBe("Enter valid JSON for Payload.");
    expect(button("Edit as fields").disabled).toBe(true);
    await type("Payload source", '{"fixed":true}');
    expect(button("Edit as fields").disabled).toBe(false);
    await click(button("Edit as fields"));
    expect(byLabel("Payload › fixed type").textContent).toContain("true");
  });

  it("unsets the field on clear and follows a parent reset", async () => {
    await render([json(), { id: "other", label: "Other", kind: "text", required: false }], {
      payload: "[1]",
      other: "kept",
    });
    await click(button("Clear"));
    expect(latest).toEqual({ other: "kept" });
    expect("payload" in latest).toBe(false);
    await choose("Payload type", "List");
    expect(latest.payload).toBe("[]");
    await act(async () => reset({}));
    expect(byLabel("Payload type").textContent).toContain("Select…");
  });

  it("sets and clears a native field named __proto__", async () => {
    await render([{ ...json(), id: "__proto__" }], { other: "kept" });
    await choose("Payload type", "List");
    expect(Object.hasOwn(latest, "__proto__")).toBe(true);
    expect(latest["__proto__"]).toBe("[]");
    expect(Object.getPrototypeOf(latest)).toBe(Object.prototype);
    await click(button("Clear"));
    expect(Object.hasOwn(latest, "__proto__")).toBe(false);
    expect(latest).toEqual({ other: "kept" });
  });

  it("disables every control", async () => {
    await render([json(), cascade()], { payload: '{"a":[1]}', area: '{"id":"10"}' }, true);
    const controls = [
      ...container.querySelectorAll<HTMLInputElement | HTMLButtonElement>("input, button"),
    ];
    expect(controls.length).toBeGreaterThan(4);
    for (const control of controls)
      expect(control.matches(":disabled, [data-disabled]"), control.outerHTML).toBe(true);
  });

  it("disables the JSON editor without an outer fieldset", async () => {
    for (const value of ['{"a":"x"}', "{oops", JSON.stringify(Array(101).fill(0))]) {
      await act(async () =>
        root.render(
          <IssueJsonField
            id="standalone-json"
            label="Payload"
            value={value}
            disabled
            onChange={() => {}}
          />,
        ),
      );
      const controls = container.querySelectorAll<HTMLInputElement | HTMLButtonElement>(
        "input, textarea, button",
      );
      expect(controls.length).toBeGreaterThan(1);
      for (const control of controls)
        expect(control.matches(":disabled"), control.outerHTML).toBe(true);
    }
  });

  it("renders a bounded number of controls for wide nested values", async () => {
    const wide = `[${Array.from({ length: 100 }, () => `[${Array(100).fill(0).join(",")}]`).join(",")}]`;
    expect(nativeFieldError([json()], { payload: wide })).toBeNull();
    await render([json()], { payload: wide });
    expect(container.querySelectorAll("input, button").length).toBeLessThan(500);
    expect(container.querySelectorAll('[aria-label$=" value"]').length).toBe(0);
    await click(
      byLabel<HTMLButtonElement>("Payload › 1 type").parentElement!.querySelector(
        "button[data-slot=button]",
      )!,
    );
    expect(container.querySelectorAll('[aria-label$=" value"]').length).toBe(100);
    expect(latest.payload).toBe(wide);
  });
});

describe("cascading select", () => {
  it("sends the native parent and child shape and resets the child with the parent", async () => {
    await render([cascade(true)]);
    expect(nativeFieldError([cascade(true)], latest)).toBe("Fill in Area.");
    expect(document.querySelector('[aria-label="Area option"]')).toBeNull();
    await choose("Area", "Hardware");
    expect(latest.area).toBe('{"id":"10"}');
    await choose("Area option", "Phone");
    expect(latest.area).toBe('{"id":"10","child":{"id":"12"}}');
    expect(nativeFieldValues([cascade(true)], latest)).toEqual({
      area: '{"id":"10","child":{"id":"12"}}',
    });
    await choose("Area option", "None");
    expect(latest.area).toBe('{"id":"10"}');
    await choose("Area option", "Laptop");
    await choose("Area", "Software");
    expect(latest.area).toBe('{"id":"20"}');
    expect(document.querySelector('[aria-label="Area option"]')).toBeNull();
    expect(nativeFieldError([cascade(true)], latest)).toBeNull();
  });

  it("keeps a stale choice invalid after a metadata refresh instead of picking a fallback", async () => {
    await render([cascade(true)]);
    await choose("Area", "Hardware");
    await choose("Area option", "Phone");
    const [hardware, software] = cascade(true).options!;
    const childRemoved = {
      ...cascade(true),
      options: [{ ...hardware!, children: [hardware!.children![0]!] }, software!],
    };
    await render([childRemoved]);
    expect(latest.area).toBe('{"id":"10","child":{"id":"12"}}');
    expect(nativeFieldError([childRemoved], latest)).toBe("Choose a value for Area.");
    const parentRemoved = { ...cascade(true), options: [software!] };
    await render([parentRemoved], { area: '{"id":"10"}' });
    await act(async () => reset({ area: '{"id":"10"}' }));
    expect(latest.area).toBe('{"id":"10"}');
    expect(nativeFieldError([parentRemoved], latest)).toBe("Choose a value for Area.");
    expect(byLabel("Area").textContent).toContain("Select…");
    await choose("Area", "Software");
    expect(latest.area).toBe('{"id":"20"}');
  });

  it("clears an optional value and blocks stored values outside the options", async () => {
    await render([cascade()], { area: '{"id":"10","child":{"id":"11"}}' });
    await choose("Area", "None");
    expect(latest).toEqual({});
    for (const area of [
      "{oops",
      '{"id":"99"}',
      '{"id":"20","child":{"id":"11"}}',
      '{"id":"10","child":{"id":"11","extra":1}}',
      '{"id":"10","name":"Hardware"}',
      '["10","11"]',
    ])
      expect(nativeFieldError([cascade()], { area }), area).toBe("Choose a value for Area.");
  });
});

it("blocks a state change until structured fields are valid", async () => {
  const onSubmit = vi.fn();
  const state: IssueState = { category: "closed", name: "Done", fields: [json(true), cascade()] };
  await act(async () =>
    root.render(
      <IssueStateFieldsDialog
        state={state}
        pending={false}
        allowed
        commentPosted={false}
        onSubmit={onSubmit}
        onCancel={() => {}}
      />,
    ),
  );
  expect(button("Change state").disabled).toBe(true);
  await choose("Payload type", "Number");
  await type("Payload value", "abc");
  expect(button("Change state").disabled).toBe(true);
  await type("Payload value", "3");
  await choose("Area", "Hardware");
  await click(button("Change state"));
  expect(onSubmit).toHaveBeenCalledExactlyOnceWith({ payload: "3", area: '{"id":"10"}' });
});
