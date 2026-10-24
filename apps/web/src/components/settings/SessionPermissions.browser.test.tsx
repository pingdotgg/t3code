import type { EnvironmentId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";

const state = vi.hoisted(() => ({
  session: null as unknown,
}));
vi.mock(import("~/state/session"), () => ({
  useEnvironmentSessionState: () =>
    state.session as ReturnType<typeof import("~/state/session").useEnvironmentSessionState>,
}));

import { SessionPermissions } from "./SessionPermissions";

function setup() {
  state.session = null;
}

it("explains unavailable permission checks without showing stale grants", async () => {
  setup();
  const data = {
    authenticated: true,
    scopes: ["environment:maintain"],
    auth: {
      policy: "remote-reachable",
      bootstrapMethods: ["one-time-token"],
      sessionMethods: ["bearer-access-token"],
      sessionCookieName: "t3_session",
    },
  } as const;
  state.session = { data, hasError: false, isPending: false };
  const environmentId = "permissions-test" as EnvironmentId;
  await using screen = await render(<SessionPermissions environmentId={environmentId} connected />);
  await expect.element(screen.getByRole("list")).toBeVisible();

  state.session = { data, hasError: true, isPending: false };
  await screen.rerender(<SessionPermissions environmentId={environmentId} connected />);
  await expect
    .element(screen.getByText("Could not check this session’s permissions."))
    .toBeVisible();
  await expect.element(screen.getByRole("list")).not.toBeInTheDocument();

  state.session = { data: null, hasError: false, isPending: true };
  await screen.rerender(<SessionPermissions environmentId={environmentId} connected />);
  await expect.element(screen.getByText("Checking this session’s permissions…")).toBeVisible();
  await expect.element(screen.getByRole("list")).not.toBeInTheDocument();

  state.session = { data: { ...data, authenticated: false }, hasError: false, isPending: false };
  await screen.rerender(<SessionPermissions environmentId={environmentId} connected />);
  await expect.element(screen.getByText("This connection is not authenticated.")).toBeVisible();
  await expect.element(screen.getByRole("list")).not.toBeInTheDocument();

  await screen.rerender(<SessionPermissions environmentId={environmentId} connected={false} />);
  await expect.element(screen.getByText(/Connect to this environment/)).toBeVisible();
});
