import { isClientHostEnvironment } from "./clientHostEnvironment";
import {
  PrimaryConnectionTarget,
  SshConnectionTarget,
  RelayConnectionTarget,
} from "@t3tools/client-runtime/connection";
import { EnvironmentId } from "@t3tools/contracts";
import { Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { createThemeEnvironmentIdAtom } from "./primaryEnvironment";

const PRIMARY = EnvironmentId.make("primary");
const SERVICE = EnvironmentId.make("service");
const REMOTE = EnvironmentId.make("remote");

function themeEnvironmentId(input: {
  primary: EnvironmentId | null;
  host: string | null;
  catalog: ReadonlyArray<EnvironmentId>;
}) {
  const atom = createThemeEnvironmentIdAtom({
    primaryEnvironmentIdAtom: Atom.make(input.primary),
    hostEnvironmentIdAtom: Atom.make(input.host),
    catalogValueAtom: Atom.make({ entries: new Map(input.catalog.map((id) => [id, null])) }),
  });
  return AtomRegistry.make().get(atom);
}

describe("themeEnvironmentIdAtom", () => {
  it("prefers the primary environment over this machine's background service", () => {
    expect(
      themeEnvironmentId({ primary: PRIMARY, host: "service", catalog: [PRIMARY, SERVICE] }),
    ).toBe(PRIMARY);
  });

  it("uses the connected background service sharing the app's T3 home when there is no primary", () => {
    expect(themeEnvironmentId({ primary: null, host: "service", catalog: [REMOTE, SERVICE] })).toBe(
      SERVICE,
    );
  });

  it("uses no environment when that service is not among the connections", () => {
    expect(themeEnvironmentId({ primary: null, host: "service", catalog: [REMOTE] })).toBeNull();
    expect(themeEnvironmentId({ primary: null, host: null, catalog: [REMOTE] })).toBeNull();
  });
});

it("recognizes the desktop host service and direct browser loopback, excluding remote primaries", () => {
  const target = (httpBaseUrl: string) =>
    new PrimaryConnectionTarget({
      environmentId: PRIMARY,
      label: "Local",
      httpBaseUrl,
      wsBaseUrl: "ws://localhost/ws",
    });
  expect(isClientHostEnvironment(SERVICE, "service", null, true)).toBe(true);
  expect(isClientHostEnvironment(REMOTE, "service", target("https://remote.example"), false)).toBe(
    false,
  );
  expect(isClientHostEnvironment(PRIMARY, null, target("http://localhost:3000"), false)).toBe(true);
  expect(isClientHostEnvironment(PRIMARY, null, target("http://127.0.0.1:3000"), false)).toBe(true);
  expect(isClientHostEnvironment(PRIMARY, null, target("https://remote.example"), true)).toBe(true);
  expect(isClientHostEnvironment(REMOTE, null, null, true)).toBe(false);
  for (const target of [
    new SshConnectionTarget({ environmentId: REMOTE, label: "SSH", connectionId: "ssh-1" }),
    new RelayConnectionTarget({ environmentId: REMOTE, label: "Relay" }),
  ]) {
    expect(isClientHostEnvironment(REMOTE, "service", target, true)).toBe(false);
  }
});
