import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";

const state = vi.hoisted(() => ({ connect: vi.fn() }));

vi.mock("../../connection/onboarding", () => ({ connectPairing: {} }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.connect }));
vi.mock("../../environments/primary", () => ({
  peekPairingTokenFromUrl: () => null,
  stripPairingTokenFromUrl: () => undefined,
  submitServerAuthCredential: () => Promise.resolve(),
}));
vi.mock("../../hostedPairing", () => ({
  readHostedPairingRequest: () => ({ host: "backend.example.com", token: "one-time", label: "" }),
}));

import { HostedPairingRouteSurface } from "./PairingRouteSurface";

it("sends a link's pairing token only after the user confirms the backend", async () => {
  state.connect.mockReset();
  state.connect.mockResolvedValue(AsyncResult.success(undefined));
  await using screen = await render(<HostedPairingRouteSurface />);

  await expect.element(screen.getByText("https://backend.example.com")).toBeVisible();
  expect(state.connect).not.toHaveBeenCalled();

  await screen.getByRole("button", { name: "Add backend" }).click();
  await vi.waitFor(() =>
    expect(state.connect).toHaveBeenCalledExactlyOnceWith({
      host: "backend.example.com",
      pairingCode: "one-time",
    }),
  );
});
