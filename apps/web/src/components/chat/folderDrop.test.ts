import {
  BearerConnectionTarget,
  RelayConnectionTarget,
  SshConnectionTarget,
} from "@t3tools/client-runtime/connection";
import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { folderDropTarget } from "./folderDrop";

const environmentId = EnvironmentId.make("saved-local");
const base = { environmentId, label: "server" };
const savedServer = (httpBaseUrl: string, connectionId = "saved-1") => ({
  target: new BearerConnectionTarget({ ...base, connectionId }),
  httpBaseUrl,
});
const thinClient = {
  localEnvironmentDisabled: true,
  environmentId,
  primaryEnvironmentId: null,
  isDesktopRenderer: true,
};

describe("folderDropTarget", () => {
  it.each([
    [
      "the bundled primary",
      {
        ...thinClient,
        localEnvironmentDisabled: false,
        primaryEnvironmentId: environmentId,
        connection: null,
      },
      "local",
    ],
    [
      "a saved loopback server on desktop",
      { ...thinClient, connection: savedServer("http://127.0.0.1:3773") },
      "local",
    ],
    [
      "a saved LAN server",
      { ...thinClient, connection: savedServer("http://192.168.1.20:3773") },
      "remote",
    ],
    [
      "a saved loopback server in a browser",
      { ...thinClient, isDesktopRenderer: false, connection: savedServer("http://localhost:3773") },
      "remote",
    ],
    [
      "a desktop WSL backend",
      { ...thinClient, connection: savedServer("http://127.0.0.1:3774", "local:wsl-ubuntu") },
      "remote",
    ],
    [
      "an SSH forward on loopback",
      {
        ...thinClient,
        connection: {
          target: new SshConnectionTarget({ ...base, connectionId: "ssh-1" }),
          httpBaseUrl: "http://127.0.0.1:41000",
        },
      },
      "remote",
    ],
    [
      "a relay connection",
      {
        ...thinClient,
        connection: {
          target: new RelayConnectionTarget(base),
          httpBaseUrl: "https://relay.t3.codes",
        },
      },
      "remote",
    ],
    ["an unprepared connection", { ...thinClient, connection: null }, "remote"],
  ] as const)("targets %s", (_name, input, expected) => {
    expect(folderDropTarget(input)).toBe(expected);
  });
});
