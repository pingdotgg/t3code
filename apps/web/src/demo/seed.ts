/**
 * Seeds first-visit client state for the demo: Sidebar V2 on, the fake remote
 * machines registered in the connection catalog (so T3 Connect environments
 * show up and connect through the demo transport), and the browser panel open
 * on a couple of showcase threads. Existing state is never overwritten, so a
 * visitor's own toggles and panel layout persist across reloads.
 */
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { EnvironmentId } from "@t3tools/contracts";
import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  BearerConnectionTarget,
} from "@t3tools/client-runtime/connection";
import { ConnectionCatalogDocument } from "@t3tools/client-runtime/platform";
import * as Schema from "effect/Schema";

import { readBrowserClientSettings, writeBrowserClientSettings } from "../clientPersistenceStorage";
import { APP_VERSION } from "../branding";
import {
  buildVersionMismatchDismissalKey,
  dismissVersionMismatch,
  resolveVersionMismatch,
} from "../versionSkew";
import {
  demoBrowserPanelThreadKeys,
  demoDiffPanelSelectionByThreadKey,
  demoEnvironments,
} from "./fixtures";
import { makeDemoSeedMarker, resolveDemoSeedStaleness } from "./seedState";
import { demoServerVersionFor, type DemoStage } from "./stage";

const CONNECTION_DATABASE_NAME = "t3code:connection-runtime";
const CONNECTION_DATABASE_VERSION = 4;
const CATALOG_STORE_NAME = "catalog";
const CATALOG_KEY = "document";

const RIGHT_PANEL_STORAGE_KEY = "t3code:right-panel-state:v2";
const RIGHT_PANEL_STORAGE_VERSION = 7;

const DIFF_PANEL_STORAGE_KEY = "t3code:diff-panel-state:v1";
const DIFF_PANEL_STORAGE_VERSION = 1;
const DEMO_FIXTURE_VERSION = 2;

/**
 * Identifies the fixture generation the visitor's persisted state was seeded
 * from. When the fixtures change (new environments/threads), stale seeded
 * state would reference machines that no longer exist, so it is re-seeded.
 */
const DEMO_SEED_VERSION_KEY = "t3code:demo-seed-version";
const LEGACY_DEMO_PANEL_SEED_VERSION_KEY = "t3code:demo-panel-seed-version";
const LEGACY_DEMO_CATALOG_SEED_VERSION_KEY = "t3code:demo-catalog-seed-version";
const DEMO_SEED_VERSION = JSON.stringify({
  fixtureVersion: DEMO_FIXTURE_VERSION,
  environments: demoEnvironments.map((environment) => ({
    environmentId: environment.environmentId,
    label: environment.label,
    origin: environment.origin,
  })),
  browserPanelThreadKeys: demoBrowserPanelThreadKeys,
  diffPanelSelections: demoDiffPanelSelectionByThreadKey,
});

const encodeCatalogDocument = Schema.encodeSync(Schema.fromJsonString(ConnectionCatalogDocument));

function readLocalStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeLocalStorage(key: string, value: string): boolean {
  try {
    window.localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function demoCatalogDocument(): string {
  const remotes = demoEnvironments.filter(
    (environment) => environment.origin !== null && environment.bearerToken !== null,
  );
  return encodeCatalogDocument({
    schemaVersion: 1,
    targets: remotes.map(
      (environment) =>
        new BearerConnectionTarget({
          environmentId: EnvironmentId.make(environment.environmentId),
          label: environment.label,
          connectionId: `demo-connection-${environment.environmentId}`,
        }),
    ),
    profiles: remotes.map(
      (environment) =>
        new BearerConnectionProfile({
          connectionId: `demo-connection-${environment.environmentId}`,
          environmentId: EnvironmentId.make(environment.environmentId),
          label: environment.label,
          httpBaseUrl: environment.origin as string,
          wsBaseUrl: (environment.origin as string).replace(/^http/, "ws"),
        }),
    ),
    credentials: remotes.map((environment) => ({
      connectionId: `demo-connection-${environment.environmentId}`,
      credential: new BearerConnectionCredential({ token: environment.bearerToken as string }),
    })),
    remoteDpopTokens: [],
  });
}

/** Registers the fake remote machines unless a current catalog already exists. */
function seedConnectionCatalog(force: boolean): Promise<boolean> {
  return new Promise((resolve) => {
    if (typeof indexedDB === "undefined") {
      resolve(false);
      return;
    }
    let settled = false;
    const settle = (result: boolean) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const request = indexedDB.open(CONNECTION_DATABASE_NAME, CONNECTION_DATABASE_VERSION);
    request.addEventListener("upgradeneeded", () => {
      // Mirror the store set the app's connection storage creates, so the
      // app's own open() (same version) does not need another upgrade.
      for (const store of ["catalog", "shell", "thread", "server-config", "vcs-refs"]) {
        if (!request.result.objectStoreNames.contains(store)) {
          request.result.createObjectStore(store);
        }
      }
    });
    request.addEventListener("blocked", () => settle(false));
    request.addEventListener("error", () => settle(false));
    request.addEventListener("success", () => {
      const database = request.result;
      if (settled) {
        database.close();
        return;
      }
      let read: IDBRequest;
      try {
        read = database
          .transaction(CATALOG_STORE_NAME, "readonly")
          .objectStore(CATALOG_STORE_NAME)
          .get(CATALOG_KEY);
      } catch {
        database.close();
        settle(false);
        return;
      }
      read.addEventListener("error", () => {
        database.close();
        settle(false);
      });
      read.addEventListener("success", () => {
        if (!force && typeof read.result === "string" && read.result.trim() !== "") {
          database.close();
          settle(true);
          return;
        }
        const staleStores = ["shell", "thread", "server-config", "vcs-refs"].filter((store) =>
          database.objectStoreNames.contains(store),
        );
        let write: IDBTransaction;
        try {
          write = database.transaction([CATALOG_STORE_NAME, ...staleStores], "readwrite");
        } catch {
          database.close();
          settle(false);
          return;
        }
        for (const store of staleStores) {
          write.objectStore(store).clear();
        }
        write.objectStore(CATALOG_STORE_NAME).put(demoCatalogDocument(), CATALOG_KEY);
        write.addEventListener("complete", () => {
          database.close();
          settle(true);
        });
        write.addEventListener("error", () => {
          database.close();
          settle(false);
        });
        write.addEventListener("abort", () => {
          database.close();
          settle(false);
        });
      });
    });
  });
}

/**
 * Opens the right panel (on the diff surface — the browser preview needs the
 * desktop bridge) on the showcase threads for first-time visitors.
 */
function seedRightPanelState(force: boolean): boolean {
  if (!force && readLocalStorage(RIGHT_PANEL_STORAGE_KEY) !== null) {
    return true;
  }
  const byThreadKey = Object.fromEntries(
    demoBrowserPanelThreadKeys.map((threadKey) => [
      threadKey,
      {
        isOpen: true,
        activeSurfaceId: "diff",
        surfaces: [{ id: "diff", kind: "diff" }],
      },
    ]),
  );
  return writeLocalStorage(
    RIGHT_PANEL_STORAGE_KEY,
    JSON.stringify({ state: { byThreadKey }, version: RIGHT_PANEL_STORAGE_VERSION }),
  );
}

/**
 * Points the diff panel at the latest checkpoint on the showcase thread so the
 * rendered diff (not an empty working-tree view) greets first-time visitors.
 */
function seedDiffPanelSelection(force: boolean): boolean {
  if (!force && readLocalStorage(DIFF_PANEL_STORAGE_KEY) !== null) {
    return true;
  }
  const byThreadKey = Object.fromEntries(
    Object.entries(demoDiffPanelSelectionByThreadKey).map(([threadKey, turnId]) => [
      threadKey,
      {
        kind: "turn",
        turnId,
        filePath: null,
        revealRequestId: 1,
      },
    ]),
  );
  return writeLocalStorage(
    DIFF_PANEL_STORAGE_KEY,
    JSON.stringify({
      state: {
        byThreadKey,
        branchBaseRefByThreadKey: {},
      },
      version: DIFF_PANEL_STORAGE_VERSION,
    }),
  );
}

/**
 * The channel-preview builds (?stage=nightly/dev) report stage-suffixed server
 * versions so the real branding + stage art react to them, which would also
 * trip the client/server version-skew banner. Pre-dismiss it — the skew is
 * intentional demo fixture data, not something a visitor should resolve.
 */
function seedVersionMismatchDismissals(): void {
  const stages: ReadonlyArray<DemoStage> = ["latest", "nightly", "dev"];
  for (const stage of stages) {
    const mismatch = resolveVersionMismatch(demoServerVersionFor(APP_VERSION, stage));
    if (!mismatch) continue;
    for (const environment of demoEnvironments) {
      dismissVersionMismatch(
        buildVersionMismatchDismissalKey(EnvironmentId.make(environment.environmentId), mismatch),
      );
    }
  }
}

export async function seedDemoClientState(): Promise<void> {
  // The demo showcases the Sidebar v2 beta by default; visitors can still
  // toggle it in Settings, and their choice persists.
  if (readBrowserClientSettings() === null) {
    try {
      writeBrowserClientSettings({ ...DEFAULT_CLIENT_SETTINGS, sidebarV2Enabled: true });
    } catch {
      // The demo remains usable when browser storage is blocked or full.
    }
  }
  seedVersionMismatchDismissals();
  // The original marker proved both storage surfaces were seeded. A short-lived
  // split-marker implementation also wrote separate panel/catalog keys, so the
  // unified state migration accepts both layouts without destructive re-seeds.
  const { stalePanelFixtures, staleCatalogFixtures } = resolveDemoSeedStaleness({
    seedVersion: readLocalStorage(DEMO_SEED_VERSION_KEY),
    legacyPanelSeedVersion: readLocalStorage(LEGACY_DEMO_PANEL_SEED_VERSION_KEY),
    legacyCatalogSeedVersion: readLocalStorage(LEGACY_DEMO_CATALOG_SEED_VERSION_KEY),
    currentVersion: DEMO_SEED_VERSION,
  });

  const rightPanelSeeded = seedRightPanelState(stalePanelFixtures);
  const diffPanelSeeded = seedDiffPanelSelection(stalePanelFixtures);
  const panelsSeeded = rightPanelSeeded && diffPanelSeeded;
  if (panelsSeeded) {
    writeLocalStorage(
      DEMO_SEED_VERSION_KEY,
      makeDemoSeedMarker(staleCatalogFixtures ? "catalog-pending" : "current", DEMO_SEED_VERSION),
    );
  }

  const catalogSeeded = await seedConnectionCatalog(staleCatalogFixtures);
  if (catalogSeeded) {
    writeLocalStorage(
      DEMO_SEED_VERSION_KEY,
      makeDemoSeedMarker(panelsSeeded ? "current" : "panels-pending", DEMO_SEED_VERSION),
    );
  }
}
