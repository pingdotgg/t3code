// @effect-diagnostics nodeBuiltinImport:off
import { describe, expect, it } from "@effect/vitest";
import type { ApiDefinition } from "@t3tools/extension-sdk/capabilities";
import * as Catalogue from "@t3tools/extension-sdk/catalogue";
import {
  resolveCapabilities,
  type ResolutionInstallation,
} from "@t3tools/extension-runtime/resolution";
import * as Effect from "effect/Effect";
import * as NodeFS from "node:fs";

const packSource = (pack: string) =>
  new URL(`../../../../packages/first-party-extensions/${pack}/extension.ts`, import.meta.url);

/** The first-party packs in this checkout (a partial checkout may carry only some). */
const PACKS = ["agents", "browser", "diff", "files", "terminal", "version-control"].filter((pack) =>
  NodeFS.existsSync(packSource(pack)),
);

/**
 * The authored manifests. Files and Agents commit no bundle; each committed
 * bundle's freshness test pins it to this same source.
 */
const loadInstallations = Effect.forEach(PACKS, (pack, index) =>
  Effect.promise(
    () => import(`../../../../packages/first-party-extensions/${pack}/extension.ts`),
  ).pipe(
    Effect.map((module): ResolutionInstallation => ({
      id: `first-party.${pack}.${index}`,
      enabled: true,
      package: module.default.package,
    })),
  ),
);

/** Every catalogue API no pack provides, at its newest version, as a current host has it. */
function hostApis(
  installations: readonly ResolutionInstallation[],
  overrides: Record<string, string> = {},
): ApiDefinition[] {
  const packProvided = new Set(
    installations.flatMap((item) => (item.package.provides ?? []).map(({ id }) => id)),
  );
  const newest = new Map<string, ApiDefinition>();
  for (const value of Object.values(Catalogue)) {
    const definition = (value as { definition?: ApiDefinition } | null)?.definition;
    if (typeof definition?.id !== "string" || packProvided.has(definition.id)) continue;
    const current = newest.get(definition.id);
    if (!current || current.version.localeCompare(definition.version, "en", { numeric: true }) < 0)
      newest.set(definition.id, definition);
  }
  return [...newest.values()].map((definition) =>
    definition.id in overrides ? { ...definition, version: overrides[definition.id]! } : definition,
  );
}

const statuses = (
  installations: readonly ResolutionInstallation[],
  apis: readonly ApiDefinition[],
) =>
  resolveCapabilities({
    installations,
    providers: apis.map((definition) => ({ providerId: `host:${definition.id}`, definition })),
  }).plugins.map(({ status, reason }) => ({ status, reason: reason?.relatedIds }));

describe("first-party pack manifests", () => {
  it.effect("all install together with no API selections", () =>
    Effect.gen(function* () {
      const installations = yield* loadInstallations;
      const resolution = resolveCapabilities({
        installations,
        providers: hostApis(installations).map((definition) => ({
          providerId: `host:${definition.id}`,
          definition,
        })),
      });
      expect(resolution.apis.filter((api) => api.reason)).toEqual([]);
      expect(resolution.plugins.filter((plugin) => plugin.status !== "available")).toEqual([]);
    }),
  );

  // The package-asset proof lives in the SDK examples; the production Files
  // pack must not ship (or render) its fixture.
  it.effect.skipIf(!PACKS.includes("files"))("Files ships no package-asset fixture", () =>
    Effect.gen(function* () {
      const pack = "files";
      const files = yield* Effect.promise(
        () => import(`../../../../packages/first-party-extensions/${pack}/extension.ts`),
      );
      // Declared asset paths ride the authored extension; the package only
      // carries the packer's placeholder, and any asset bumps it to format 4.
      expect(files.default.assets ?? []).toEqual([]);
      expect(files.default.package.format).toBeLessThan(4);
    }),
  );

  it.effect("load on a host whose t3.ui/notifications is still 1.0.0", () =>
    Effect.gen(function* () {
      const installations = yield* loadInstallations;
      const available = PACKS.map(() => ({ status: "available", reason: undefined }));
      expect(statuses(installations, hostApis(installations))).toEqual(available);
      expect(
        statuses(installations, hostApis(installations, { "t3.ui/notifications": "1.0.0" })),
      ).toEqual(available);
    }),
  );
});
