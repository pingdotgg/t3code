import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";

import { AVAILABLE_CONNECTION_STATE, PrimaryConnectionTarget } from "../connection/model.ts";
import type { EnvironmentCatalogState } from "./connections.ts";
import { createEnvironmentPresentationAtoms } from "./presentation.ts";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");

describe("environment presentations", () => {
  it("keeps catalog entries visible while enabled state is unresolved", () => {
    const entry = {
      target: new PrimaryConnectionTarget({
        environmentId: ENVIRONMENT_ID,
        label: "Environment",
        httpBaseUrl: "https://environment.example.test",
        wsBaseUrl: "wss://environment.example.test",
      }),
      profile: Option.none(),
    };
    const catalogValueAtom = Atom.make<EnvironmentCatalogState>({
      isReady: true,
      entries: new Map([[ENVIRONMENT_ID, entry]]),
    });
    const stateAtom = Atom.family((_environmentId: EnvironmentId) =>
      Atom.make(AsyncResult.success(AVAILABLE_CONNECTION_STATE)),
    );
    const enabledAtom = Atom.family((_environmentId: EnvironmentId) =>
      Atom.make(AsyncResult.initial<boolean | null, never>()),
    );
    const serverConfigValueAtom = Atom.family((_environmentId: EnvironmentId) => Atom.make(null));
    const presentations = createEnvironmentPresentationAtoms({
      catalogValueAtom,
      stateAtom,
      enabledAtom,
      serverConfigValueAtom,
    });
    const registry = AtomRegistry.make();

    expect(registry.get(presentations.presentationsAtom).get(ENVIRONMENT_ID)).toMatchObject({
      entry,
      enabled: false,
    });

    registry.dispose();
  });
});
