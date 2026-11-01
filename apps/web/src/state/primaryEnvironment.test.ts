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
