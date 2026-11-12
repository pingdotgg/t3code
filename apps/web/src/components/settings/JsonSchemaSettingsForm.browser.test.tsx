import type * as Schema from "effect/Schema";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { act, render } from "../../../test/render";
import { JsonSchemaSettingsForm } from "./JsonSchemaSettingsForm";

const schema = {
  type: "object",
  properties: { a: { type: "boolean" }, b: { type: "boolean" } },
};

type SaveResult = { readonly settings: Schema.JsonObject } | { readonly problem: string };

// Applies each patch when it arrives, as the server does, and holds the answer until the test
// delivers it, so answers can come back late or out of order.
function fakeServer(initial: Schema.JsonObject) {
  let settings = initial;
  const answers: Array<{ readonly answer: Promise<SaveResult>; readonly deliver: () => void }> = [];
  const onSave = vi.fn((patch: Schema.JsonObject) => {
    settings = { ...settings, ...patch };
    const snapshot = settings;
    let deliver = () => {};
    const answer = new Promise<SaveResult>((resolve) => {
      deliver = () => resolve({ settings: snapshot });
    });
    answers.push({ answer, deliver });
    return answer;
  });
  return {
    onSave,
    settings: () => settings,
    // Resolves once the form has taken the answers.
    deliverNewestFirst: () =>
      act(() => {
        const delivered = answers.splice(0).toReversed();
        for (const { deliver } of delivered) deliver();
        return Promise.all(delivered.map(({ answer }) => answer));
      }),
  };
}

const form = (
  settings: Schema.JsonObject,
  onSave: (patch: Schema.JsonObject) => Promise<SaveResult>,
  formSchema: Schema.JsonObject = schema,
) => (
  <JsonSchemaSettingsForm
    idPrefix="test"
    label="Test plugin"
    schema={formSchema}
    settings={settings}
    canSave
    onSave={onSave}
  />
);

describe("JsonSchemaSettingsForm", () => {
  it("retries a reset after its first save fails", async () => {
    const onSave = vi
      .fn<(patch: Schema.JsonObject) => Promise<SaveResult>>()
      .mockResolvedValueOnce({ problem: "Temporarily unavailable." })
      .mockResolvedValueOnce({ settings: {} });
    await using _screen = await render(form({ a: true }, onSave));
    const reset = page.getByRole("button", { name: "Reset a to default" });

    await reset.click();
    await expect.element(page.getByText("Temporarily unavailable.")).toBeVisible();
    await reset.click();

    await vi.waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
    expect(onSave.mock.calls.map(([patch]) => patch)).toEqual([{ a: null }, { a: null }]);
    await expect.element(page.getByText("Temporarily unavailable.")).not.toBeInTheDocument();
    await expect.element(page.getByRole("switch", { name: "a" })).not.toBeChecked();
    await expect.element(reset).not.toBeInTheDocument();
  });

  it("keeps a number's later revert after an invalid draft during a save", async () => {
    const server = fakeServer({ n: 5 });
    const numberSchema = { type: "object", properties: { n: { type: "number" } } };
    await using _screen = await render(form({ n: 5 }, server.onSave, numberSchema));
    const n = page.getByRole("textbox", { name: "n" });

    await userEvent.fill(n, "6");
    await userEvent.tab();
    await vi.waitFor(() => expect(server.onSave).toHaveBeenCalledTimes(1));
    await userEvent.fill(n, "abc");
    await userEvent.tab();
    await expect.element(page.getByText("n must be a number.")).toBeVisible();
    await userEvent.fill(n, "5");
    await userEvent.tab();
    await server.deliverNewestFirst();
    await vi.waitFor(() => expect(server.onSave).toHaveBeenCalledTimes(2));
    await server.deliverNewestFirst();

    expect(server.onSave.mock.calls.map(([patch]) => patch)).toEqual([{ n: 6 }, { n: 5 }]);
    expect(server.settings()).toEqual({ n: 5 });
    await expect.element(n).toHaveValue("5");
    await expect.element(page.getByText("n must be a number.")).not.toBeInTheDocument();
  });

  it("saves a field turned back while its first save is in flight", async () => {
    const server = fakeServer({ a: false });
    await using _screen = await render(form({ a: false }, server.onSave));
    const a = page.getByRole("switch", { name: "a" });

    await a.click();
    await expect.element(a).toBeChecked();
    await a.click();
    await expect.element(a).not.toBeChecked();
    await server.deliverNewestFirst();
    await vi.waitFor(() => expect(server.onSave).toHaveBeenCalledTimes(2));
    await server.deliverNewestFirst();

    expect(server.onSave.mock.calls.map(([patch]) => patch)).toEqual([{ a: true }, { a: false }]);
    expect(server.settings()).toEqual({ a: false });
    await expect.element(a).not.toBeChecked();
  });

  it("shows each field's saved value when saves of two fields answer out of order", async () => {
    const server = fakeServer({ a: false, b: false });
    await using _screen = await render(form({ a: false, b: false }, server.onSave));
    const a = page.getByRole("switch", { name: "a" });
    const b = page.getByRole("switch", { name: "b" });

    await a.click();
    await b.click();
    await server.deliverNewestFirst();
    await vi.waitFor(() => expect(server.onSave).toHaveBeenCalledTimes(2));
    await server.deliverNewestFirst();

    expect(server.settings()).toEqual({ a: true, b: true });
    await expect.element(a).toBeChecked();
    await expect.element(b).toBeChecked();
  });

  it("takes newer settings from the server into clean fields and keeps unsaved edits", async () => {
    const refused = vi.fn(async () => ({ problem: "Refused." }));
    await using screen = await render(form({ a: false, b: false }, refused));
    const a = page.getByRole("switch", { name: "a" });
    const b = page.getByRole("switch", { name: "b" });

    // `a` keeps the change the server refused; `b` was never edited.
    await a.click();
    await expect.element(page.getByText("Refused.")).toBeVisible();
    await screen.rerender(form({ a: false, b: true }, refused));
    await expect.element(b).toBeChecked();
    await expect.element(a).toBeChecked();

    // Settings edited as JSON follow the server until they are edited.
    const jsonSchema = { type: "object", properties: { nested: { type: "object" } } };
    await using jsonScreen = await render(form({ nested: { n: 1 } }, refused, jsonSchema));
    const json = page.getByRole("textbox", { name: "Test plugin settings JSON" });
    await expect.element(json).toHaveValue(JSON.stringify({ nested: { n: 1 } }, null, 2));
    await jsonScreen.rerender(form({ nested: { n: 2 } }, refused, jsonSchema));
    await expect.element(json).toHaveValue(JSON.stringify({ nested: { n: 2 } }, null, 2));
    await userEvent.fill(json, '{ "nested": { "n": 3 } }');
    await jsonScreen.rerender(form({ nested: { n: 4 } }, refused, jsonSchema));
    await expect.element(json).toHaveValue('{ "nested": { "n": 3 } }');
  });
});
