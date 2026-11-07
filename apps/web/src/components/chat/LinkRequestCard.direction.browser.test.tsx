import type { LinkRequestItem } from "@t3tools/client-runtime/link-request";
import { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { expect, it, vi } from "vite-plus/test";

vi.mock("@effect/atom-react", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useAtomValue: () => true,
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => async () => ({ _tag: "Success", value: undefined }),
}));
vi.mock("../../state/session", () => ({
  useEnvironmentScope: () => false,
  usePreparedConnection: () => Option.none(),
}));
vi.mock("../../state/peerPairingCode", () => ({ mintPairingCodeOn: async () => null }));
vi.mock("../../state/peerLinks", () => ({
  peerLinkEnvironment: { answerRequest: { permissionAtom: () => ({}) } },
  useLinkableMachines: () => [],
}));

import "~/index.css";
import { render } from "../../../test/render";
import { LinkRequestCard } from "./LinkRequestCard";

const renderCard = (reason: string) =>
  render(
    <LinkRequestCard
      environmentId={EnvironmentId.make("env")}
      visibility="local"
      item={{ linkStatus: "pending", reason } as LinkRequestItem}
    />,
  );

it("reads a Hebrew reason right to left and keeps its code left to right", async () => {
  await using screen = await renderCard("צריך גישה ל-VPS כדי להריץ את `pnpm build` שם.");
  await expect.element(screen.getByText(/צריך גישה/)).toHaveStyle({ direction: "rtl" });
  await expect.element(screen.getByText("`pnpm build`")).toHaveStyle({ direction: "ltr" });
  await expect
    .element(screen.getByText("Link a machine to this environment"))
    .toHaveStyle({ direction: "ltr" });
});

it("leaves an English reason left to right", async () => {
  await using screen = await renderCard("I need the VPS to run the build there.");
  await expect
    .element(screen.getByText("I need the VPS to run the build there."))
    .toHaveStyle({ direction: "ltr" });
});
