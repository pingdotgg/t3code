import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import { SpeechEndpointForm } from "./SpeechEndpointForm";

const current = {
  url: "http://localhost:8000/v1/audio/transcriptions",
  model: "whisper",
  apiKey: "••••••",
};

it("preserves a masked key only for its original URL and clears the replacement after saving", async () => {
  const onSave = vi.fn(async () => true);
  await using screen = await render(
    <SpeechEndpointForm
      current={current}
      disabled={false}
      environmentLabel="Test environment"
      onSave={onSave}
    />,
  );
  const key = screen.getByLabelText("Speech endpoint API key");
  const save = screen.getByRole("button", { name: "Save and use endpoint" });
  await expect.element(key).toHaveValue("");
  await expect
    .element(key)
    .toHaveAttribute("placeholder", "Stored secret, enter a new value to replace");
  await userEvent.click(save);
  await vi.waitFor(() => expect(onSave).toHaveBeenLastCalledWith(current));

  const url = "https://other.example.test/v1/audio/transcriptions";
  await userEvent.fill(screen.getByLabelText("Transcription URL"), url);
  await expect.element(key).toHaveAttribute("placeholder", "Not set");
  await userEvent.click(save);
  await vi.waitFor(() => expect(onSave).toHaveBeenLastCalledWith({ ...current, url, apiKey: "" }));
  await userEvent.fill(key, "replacement-key");
  await userEvent.click(save);
  await vi.waitFor(() =>
    expect(onSave).toHaveBeenLastCalledWith({ ...current, url, apiKey: "replacement-key" }),
  );
  await expect.element(key).toHaveValue("");
});

it("removes a stored credential and switches back to local models", async () => {
  const onSave = vi.fn(async () => true);
  await using screen = await render(
    <SpeechEndpointForm
      current={current}
      disabled={false}
      environmentLabel="Test environment"
      onSave={onSave}
    />,
  );
  await userEvent.click(screen.getByRole("button", { name: "Remove stored API key" }));
  await userEvent.click(screen.getByRole("button", { name: "Save and use endpoint" }));
  await vi.waitFor(() => expect(onSave).toHaveBeenLastCalledWith({ ...current, apiKey: "" }));
  await userEvent.click(screen.getByRole("combobox", { name: "Speech engine" }));
  await userEvent.click(page.getByRole("option", { name: "Local models", exact: true }));
  await userEvent.click(screen.getByRole("button", { name: "Use local models" }));
  await vi.waitFor(() => expect(onSave).toHaveBeenLastCalledWith(null));
});

it("rejects URL credentials and keeps an unsuccessful replacement for retry", async () => {
  const pending = Promise.withResolvers<boolean>();
  const onSave = vi.fn(() => pending.promise);
  await using screen = await render(
    <SpeechEndpointForm
      current={current}
      disabled={false}
      environmentLabel="Test environment"
      onSave={onSave}
    />,
  );
  await userEvent.fill(
    screen.getByLabelText("Transcription URL"),
    "https://user:password@example.test/transcribe",
  );
  await userEvent.click(screen.getByRole("button", { name: "Save and use endpoint" }));
  await expect.element(screen.getByRole("alert")).toBeVisible();
  expect(onSave).not.toHaveBeenCalled();
  await userEvent.fill(screen.getByLabelText("Transcription URL"), current.url);
  const key = screen.getByLabelText("Speech endpoint API key");
  await userEvent.fill(key, "retry-key");
  await userEvent.click(screen.getByRole("button", { name: "Save and use endpoint" }));
  await expect.element(key).toBeDisabled();
  pending.resolve(false);
  await expect.element(screen.getByRole("alert")).toBeVisible();
  await expect.element(key).toHaveValue("retry-key");
  await expect.element(key).toBeEnabled();
});
