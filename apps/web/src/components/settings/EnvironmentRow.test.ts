import {
  BearerConnectionProfile,
  BearerConnectionTarget,
  SshConnectionProfile,
  SshConnectionTarget,
} from "@t3tools/client-runtime/connection";
import { type DesktopDiscoveredSshHost, EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";

import type { EnvironmentPresentation } from "~/state/environments";
import { unsavedDesktopSshHosts } from "./EnvironmentRow";

const environmentId = EnvironmentId.make("desk");
const sshTarget = { alias: "desk", hostname: "desk.local", username: "me", port: null };
const sshRoute = {
  target: new SshConnectionTarget({ environmentId, label: "Desk", connectionId: "ssh" }),
  profile: Option.some(
    new SshConnectionProfile({
      connectionId: "ssh",
      environmentId,
      label: "Desk",
      target: sshTarget,
    }),
  ),
};
const lanRoute = {
  target: new BearerConnectionTarget({ environmentId, label: "Desk", connectionId: "lan" }),
  profile: Option.some(
    new BearerConnectionProfile({
      connectionId: "lan",
      environmentId,
      label: "Desk",
      httpBaseUrl: "http://192.168.1.10:3773/",
      wsBaseUrl: "ws://192.168.1.10:3773/",
    }),
  ),
};

function saved(entry: EnvironmentPresentation["entry"]): EnvironmentPresentation {
  return {
    entry,
    environmentId,
    label: "Desk",
    displayUrl: null,
    relayManaged: false,
    connection: { phase: "available", error: null, traceId: null },
    serverConfig: null,
  };
}

const hosts: DesktopDiscoveredSshHost[] = [
  { ...sshTarget, source: "ssh-config" },
  { alias: "other", hostname: "other.local", username: null, port: null, source: "ssh-config" },
];

describe("unsavedDesktopSshHosts", () => {
  it.each([
    { name: "primary SSH route", entry: { ...sshRoute, enabled: true } },
    {
      name: "alternate SSH route",
      entry: { ...lanRoute, alternateRoutes: [sshRoute], enabled: true },
    },
  ])("hides a host a saved environment reaches by its $name", ({ entry }) => {
    expect(unsavedDesktopSshHosts(hosts, [saved(entry)]).map((host) => host.alias)).toEqual([
      "other",
    ]);
  });
});
