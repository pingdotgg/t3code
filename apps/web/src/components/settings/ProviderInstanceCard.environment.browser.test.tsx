import { userEvent } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";
import { ProviderEnvironmentSection } from "./ProviderInstanceCard";

const savedSecret = {
  name: "FAKE_API_KEY",
  value: "",
  sensitive: true,
  valueRedacted: true,
} as const;

const input = (label: string) =>
  document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
const lockButton = (name: string) =>
  document.querySelector<HTMLButtonElement>(
    `button[aria-label="Mark environment variable ${name} as sensitive"]`,
  )!;

describe("ProviderEnvironmentSection saved secrets", () => {
  it("keeps a saved secret's name and sensitivity until a new value replaces it", async () => {
    const onChange = vi.fn();
    await using _screen = await render(
      <ProviderEnvironmentSection environment={[savedSecret]} onChange={onChange} />,
    );

    // Either edit would publish a row whose stored value the server then deletes.
    expect(input("Environment variable name 1").disabled).toBe(true);
    await act(async () => lockButton("FAKE_API_KEY").click());
    expect(onChange).not.toHaveBeenCalled();

    await userEvent.fill(input("Environment variable value 1"), "fake-replacement");
    await act(async () => input("Environment variable value 1").blur());
    expect(onChange).toHaveBeenLastCalledWith([
      { name: "FAKE_API_KEY", value: "fake-replacement", sensitive: true, valueRedacted: false },
    ]);

    expect(input("Environment variable name 1").disabled).toBe(false);
    await act(async () => lockButton("FAKE_API_KEY").click());
    expect(onChange).toHaveBeenLastCalledWith([
      { name: "FAKE_API_KEY", value: "fake-replacement", sensitive: false, valueRedacted: false },
    ]);
  });
});
