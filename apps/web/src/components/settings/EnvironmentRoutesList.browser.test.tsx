import {
  BearerConnectionProfile,
  BearerConnectionTarget,
  type ConnectionCatalogEntry,
  type ConnectionRoute,
} from "@t3tools/client-runtime/connection";
import { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

vi.mock(import("~/state/session"), async (importOriginal) => ({
  ...(await importOriginal()),
  usePreparedConnection: (() => Option.none()) as never,
}));

vi.mock(import("~/state/use-atom-command"), async (importOriginal) => ({
  ...(await importOriginal()),
  useAtomCommand: (() => async () => ({ _tag: "Success" })) as never,
}));

import { render } from "../../../test/render";
import type { EnvironmentPresentation } from "~/state/environments";
import { EnvironmentRoutesList } from "./EnvironmentRoutesList";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");

function direct(id: string, httpBaseUrl: string): ConnectionRoute {
  return {
    target: new BearerConnectionTarget({
      environmentId: ENVIRONMENT_ID,
      label: "Desk",
      connectionId: id,
    }),
    profile: Option.some(
      new BearerConnectionProfile({
        connectionId: id,
        environmentId: ENVIRONMENT_ID,
        label: "Desk",
        httpBaseUrl,
        wsBaseUrl: httpBaseUrl.replace(/^http/, "ws"),
      }),
    ),
  };
}

const LAN = direct("lan", "http://192.168.1.10:3773/");
const TAILNET = direct("tailnet", "https://desk.tail1234.ts.net/");
const PUBLIC = direct("public", "https://desk.example.com/");

function routesList(routes: ReadonlyArray<ConnectionRoute>) {
  const [first, ...rest] = routes;
  const entry: ConnectionCatalogEntry = {
    target: first!.target,
    profile: first!.profile,
    alternateRoutes: rest,
    enabled: true,
  };
  const environment: EnvironmentPresentation = {
    environmentId: ENVIRONMENT_ID,
    label: "Desk",
    displayUrl: null,
    relayManaged: false,
    entry,
    connection: { phase: "available", error: null, traceId: null },
    serverConfig: null,
  };
  return <EnvironmentRoutesList environment={environment} onAddRoute={() => undefined} />;
}

it("shows a route added after a reorder was saved, once another route is removed", async () => {
  await using screen = await render(routesList([LAN, TAILNET]));
  await userEvent.click(screen.getByRole("button", { name: "Reorder LAN, position 1" }));
  await userEvent.keyboard(" ");
  await userEvent.keyboard("{ArrowDown}");
  await userEvent.keyboard(" ");
  await expect
    .element(screen.getByRole("button", { name: "Reorder Tailscale, position 1" }))
    .toBeVisible();

  await screen.rerender(routesList([TAILNET, LAN]));
  await screen.rerender(routesList([TAILNET, LAN, PUBLIC]));
  await screen.rerender(routesList([TAILNET, PUBLIC]));

  await expect
    .element(screen.getByRole("button", { name: "Reorder desk.example.com, position 2" }))
    .toBeVisible();
  expect(screen.getByRole("listitem").elements()).toHaveLength(2);
  await expect
    .element(screen.getByRole("button", { name: "Remove desk.example.com route" }))
    .toBeVisible();
});
