import { buildPairingAppLink } from "@t3tools/shared/remote";
import { expect, it, vi } from "vite-plus/test";

import type { ConfirmDialogRequest } from "../../components/ui/Dialog.types";

const harness = vi.hoisted(() => ({
  confirm: vi.fn<(request: ConfirmDialogRequest) => void>(),
  alert: vi.fn(),
  pair: vi.fn(),
}));

vi.mock("../../components/ui/Dialog", () => ({
  confirm: harness.confirm,
  alert: harness.alert,
}));
vi.mock("../../state/use-remote-environment-registry", () => ({
  pairEnvironment: harness.pair,
}));

import { takePairingAppLink } from "./pairingAppLink";

it("asks before pairing from the link t3 pair prints, and never routes it", async () => {
  const pairingUrl = "https://example-host.test/pair#token=ABCD1234";
  const link = buildPairingAppLink(pairingUrl);
  harness.pair.mockResolvedValue({ ok: true, error: null });

  expect(takePairingAppLink("t3code://threads")).toBe(false);
  expect(takePairingAppLink(link)).toBe(true);
  expect(harness.confirm).toHaveBeenCalledTimes(1);
  expect(harness.confirm.mock.calls[0]![0].message).toContain("https://example-host.test");
  expect(harness.pair).not.toHaveBeenCalled();

  // The same link opened again while the prompt is up does not stack a second one.
  expect(takePairingAppLink(link)).toBe(true);
  expect(harness.confirm).toHaveBeenCalledTimes(1);

  harness.confirm.mock.calls[0]![0].onConfirm();
  expect(harness.pair).toHaveBeenCalledWith(pairingUrl);
});
