import { describe, expect, it } from "@effect/vitest";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import { PluginCatalogSnapshot, pluginInstallationStatus } from "./pluginCatalog.ts";

const digest = `sha256:${"a".repeat(64)}`;
const installation = {
  installationId: "installation-1",
  generation: 1,
  directory: "/srv/plugins/notifier",
  manifest: {
    id: "acme.notifier",
    name: "Notifier",
    version: "1.0.0",
    capabilities: [],
    proposedApi: false,
  },
  source: { digest, files: 2, bytes: 120 },
  problem: null,
  inspectedAt: "2026-10-04T00:00:00.000Z",
  consent: { digest, capabilities: [], grantedAt: "2026-10-04T00:00:00.000Z" },
  enabled: true,
  hostState: { _tag: "running" },
  addedAt: "2026-10-04T00:00:00.000Z",
};
const decodeSnapshot = Schema.decodeUnknownExit(PluginCatalogSnapshot);

describe("PluginCatalogSnapshot from a newer server", () => {
  it("keeps an installation whose state or fields this client does not know", () => {
    const decoded = decodeSnapshot({
      installations: [
        { ...installation, hostState: { _tag: "hibernating" }, publisher: "acme" },
        {
          ...installation,
          installationId: "installation-2",
          // Relaxed id rules and new capability names on a newer server.
          manifest: { ...installation.manifest, id: "notifier", capabilities: ["tools"] },
        },
      ],
    });
    expect(Exit.isSuccess(decoded)).toBe(true);
    if (!Exit.isSuccess(decoded)) return;
    const [unknownState, relaxed] = decoded.value.installations;
    expect(unknownState?.hostState).toBeUndefined();
    expect(unknownState && pluginInstallationStatus(unknownState)).toBe("enabled");
    expect(relaxed?.manifest?.capabilities).toEqual(["tools"]);
    expect(relaxed?.hostState).toEqual({ _tag: "running" });
  });
});

describe("pluginInstallationStatus", () => {
  it("asks for consent again when the bytes differ from what was approved", () => {
    expect(pluginInstallationStatus(installation)).toBe("enabled");
    expect(pluginInstallationStatus({ ...installation, enabled: false })).toBe("disabled");
    expect(pluginInstallationStatus({ ...installation, consent: null, enabled: false })).toBe(
      "needs-consent",
    );
    const changed = { ...installation.source, digest: `sha256:${"b".repeat(64)}` };
    expect(pluginInstallationStatus({ ...installation, source: changed, enabled: false })).toBe(
      "needs-consent",
    );
    expect(
      pluginInstallationStatus({ ...installation, source: null, problem: "gone", enabled: false }),
    ).toBe("unavailable");
  });
});
