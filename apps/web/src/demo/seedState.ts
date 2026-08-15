const CURRENT_PREFIX = "current:";
const PANELS_PENDING_PREFIX = "panels-pending:";
const CATALOG_PENDING_PREFIX = "catalog-pending:";

export type DemoSeedMarkerState = "current" | "panels-pending" | "catalog-pending";

export function makeDemoSeedMarker(state: DemoSeedMarkerState, version: string): string {
  return `${state}:${version}`;
}

export function resolveDemoSeedStaleness(input: {
  seedVersion: string | null;
  legacyPanelSeedVersion: string | null;
  legacyCatalogSeedVersion: string | null;
  currentVersion: string;
}): {
  stalePanelFixtures: boolean;
  staleCatalogFixtures: boolean;
} {
  const currentMarker = makeDemoSeedMarker("current", input.currentVersion);
  const panelsPendingMarker = makeDemoSeedMarker("panels-pending", input.currentVersion);
  const catalogPendingMarker = makeDemoSeedMarker("catalog-pending", input.currentVersion);

  if (input.seedVersion === input.currentVersion) {
    return { stalePanelFixtures: false, staleCatalogFixtures: false };
  }
  if (input.seedVersion === currentMarker) {
    return { stalePanelFixtures: false, staleCatalogFixtures: false };
  }
  if (input.seedVersion === panelsPendingMarker) {
    return { stalePanelFixtures: true, staleCatalogFixtures: false };
  }
  if (input.seedVersion === catalogPendingMarker) {
    return { stalePanelFixtures: false, staleCatalogFixtures: true };
  }

  const isPriorStateMarker =
    input.seedVersion?.startsWith(CURRENT_PREFIX) === true ||
    input.seedVersion?.startsWith(PANELS_PENDING_PREFIX) === true ||
    input.seedVersion?.startsWith(CATALOG_PENDING_PREFIX) === true;
  if (isPriorStateMarker) {
    return { stalePanelFixtures: true, staleCatalogFixtures: true };
  }

  const panelSeedVersion = input.legacyPanelSeedVersion ?? input.seedVersion;
  const catalogSeedVersion = input.legacyCatalogSeedVersion ?? input.seedVersion;
  return {
    stalePanelFixtures: panelSeedVersion !== input.currentVersion,
    staleCatalogFixtures: catalogSeedVersion !== input.currentVersion,
  };
}
