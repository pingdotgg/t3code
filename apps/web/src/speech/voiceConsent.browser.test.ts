import type { EnvironmentCatalogState } from "@t3tools/client-runtime/state/connections";
import { EnvironmentId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { adoptHostAudioDestination, chooseAudioDestination } from "./voiceConsent";

const KEY = "t3code:voice-audio-grant:v1";
const HOST = EnvironmentId.make("host-env");
const REMOTE = EnvironmentId.make("remote-env");

function catalog(ids: ReadonlyArray<EnvironmentId>, isReady = true): EnvironmentCatalogState {
  return {
    isReady,
    entries: new Map(ids.map((id) => [id, {}])) as unknown as EnvironmentCatalogState["entries"],
  };
}

const destination = () => JSON.parse(localStorage.getItem(KEY) ?? "null")?.destination ?? null;

function emptyGrant(): Disposable {
  localStorage.removeItem(KEY);
  return { [Symbol.dispose]: () => localStorage.removeItem(KEY) };
}

it("sends voice input to this machine until the person chooses", () => {
  using _grant = emptyGrant();
  adoptHostAudioDestination(HOST, catalog([HOST, REMOTE]));
  expect(destination()).toEqual({ kind: "environment", environmentId: HOST });
});

it("returns to this machine once the chosen environment is gone", () => {
  using _grant = emptyGrant();
  chooseAudioDestination({ kind: "environment", environmentId: EnvironmentId.make("gone-env") });
  adoptHostAudioDestination(HOST, catalog([HOST, REMOTE]));
  expect(destination()).toEqual({ kind: "environment", environmentId: HOST });
});

it("keeps a chosen environment that still exists", () => {
  using _grant = emptyGrant();
  chooseAudioDestination({ kind: "environment", environmentId: REMOTE });
  const before = localStorage.getItem(KEY);
  adoptHostAudioDestination(HOST, catalog([HOST, REMOTE]));
  expect(localStorage.getItem(KEY)).toBe(before);
});

it("keeps voice input off once the person turned it off", () => {
  using _grant = emptyGrant();
  chooseAudioDestination(null);
  adoptHostAudioDestination(HOST, catalog([HOST]));
  expect(localStorage.getItem(KEY)).toBe(JSON.stringify("off"));
});

it.each([
  ["no host environment", null, catalog([HOST])],
  ["a catalog that is still loading", HOST, catalog([], false)],
  ["a host the catalog does not list", HOST, catalog([REMOTE])],
])("chooses nothing with %s", (_, host, value) => {
  using _grant = emptyGrant();
  adoptHostAudioDestination(host, value);
  expect(localStorage.getItem(KEY)).toBeNull();
});
