import { describe, expect, it, vi } from "vite-plus/test";
import type { ApiClient, ApiDiscovery } from "@t3tools/extension-sdk/capabilities";
import {
  registerInstalledApiClient,
  resolveInstalledApiProvider,
  setInstalledApiPolicy,
} from "./installedApiClients";
const context = {
  client: "web",
  resource: {
    namespace: "t3.workspace",
    id: "files",
    environmentId: "api-env",
    projectId: "project",
  },
};
const selected: ApiDiscovery = {
  id: "t3.file/presentation",
  version: "1.0.0",
  providerId: "example.files",
  pluginId: "example.files",
  generation: 1,
  health: "ready",
  selected: true,
};
const client = (apis: readonly ApiDiscovery[]): ApiClient => ({
  subscribeApi: () => ({ async *[Symbol.asyncIterator]() {} }),
  invokeApi: vi.fn(),
  discoverApis: vi.fn(async () => apis),
});
describe("installed API provider routing", () => {
  it("uses explicit selected identity instead of registration order and isolates environments", async () => {
    const first = client([selected]);
    const winner = client([selected]);
    const stops = [
      registerInstalledApiClient("api-env", "other", first),
      registerInstalledApiClient("api-env", "example.files", winner),
    ];
    try {
      expect(
        (await resolveInstalledApiProvider(selected.id, context, new AbortController().signal))
          ?.client,
      ).toBe(winner);
      expect(
        await resolveInstalledApiProvider(
          selected.id,
          { ...context, resource: { ...context.resource, environmentId: "different" } },
          new AbortController().signal,
        ),
      ).toBeNull();
    } finally {
      stops.forEach((stop) => stop());
    }
  });
  it("keeps a selected unhealthy provider unavailable rather than silently falling back", async () => {
    const stop = registerInstalledApiClient(
      "api-env",
      "example.files",
      client([{ ...selected, health: "failed" }]),
    );
    try {
      await expect(
        resolveInstalledApiProvider(selected.id, context, new AbortController().signal),
      ).rejects.toThrow("unavailable");
    } finally {
      stop();
    }
  });
  it("rejects discovery completed after an installed client was revoked", async () => {
    let finish!: (apis: readonly ApiDiscovery[]) => void;
    const deferred: ApiClient = {
      subscribeApi: () => ({ async *[Symbol.asyncIterator]() {} }),
      invokeApi: vi.fn(),
      discoverApis: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    };
    const stop = registerInstalledApiClient("api-env", "example.files", deferred);
    const pending = resolveInstalledApiProvider(selected.id, context, new AbortController().signal);
    stop();
    finish([selected]);
    await expect(pending).rejects.toThrow("changed during discovery");
  });
});

it("preserves unavailable selection after disabled clients disappear and after policy reload", async () => {
  setInstalledApiPolicy("disabled-env", {
    apiSelections: [{ id: selected.id, providerId: "removed", fallbackProviderIds: [] }],
    apiResolution: [
      {
        id: selected.id,
        reason: {
          code: "disabled",
          detail: "Selected provider is disabled",
          relatedIds: ["removed"],
        },
      },
    ],
  });
  try {
    await expect(
      resolveInstalledApiProvider(
        selected.id,
        { ...context, resource: { ...context.resource, environmentId: "disabled-env" } },
        new AbortController().signal,
      ),
    ).rejects.toThrow("disabled");
  } finally {
    setInstalledApiPolicy("disabled-env", null);
  }
});
it("rejects conflicting providers even with no live client", async () => {
  setInstalledApiPolicy("conflict-env", {
    apiSelections: [],
    apiResolution: [
      {
        id: selected.id,
        reason: { code: "conflict", detail: "Choose an API provider", relatedIds: ["a", "b"] },
      },
    ],
  });
  try {
    await expect(
      resolveInstalledApiProvider(
        selected.id,
        { ...context, resource: { ...context.resource, environmentId: "conflict-env" } },
        new AbortController().signal,
      ),
    ).rejects.toThrow("Choose");
  } finally {
    setInstalledApiPolicy("conflict-env", null);
  }
});

it("allows authoritative live discovery to replace a stale unavailable catalogue reason", async () => {
  setInstalledApiPolicy("api-env", {
    apiSelections: [{ id: selected.id, providerId: "example.files", fallbackProviderIds: [] }],
    apiResolution: [
      {
        id: selected.id,
        reason: { code: "failed", detail: "Previously failed", relatedIds: ["example.files"] },
      },
    ],
  });
  const live = client([selected]);
  const stop = registerInstalledApiClient("api-env", "example.files", live);
  try {
    expect(
      (await resolveInstalledApiProvider(selected.id, context, new AbortController().signal))
        ?.client,
    ).toBe(live);
  } finally {
    stop();
    setInstalledApiPolicy("api-env", null);
  }
});

it("does not await an unrelated hung discovery for an explicitly selected provider", async () => {
  const unrelated: ApiClient = {
    subscribeApi: () => ({ async *[Symbol.asyncIterator]() {} }),
    invokeApi: vi.fn(),
    discoverApis: vi.fn(() => new Promise<readonly ApiDiscovery[]>(() => {})),
  };
  const winner = client([selected]);
  const stops = [
    registerInstalledApiClient("api-env", "unrelated", unrelated),
    registerInstalledApiClient("api-env", "example.files", winner),
  ];
  setInstalledApiPolicy("api-env", {
    apiSelections: [{ id: selected.id, providerId: "example.files", fallbackProviderIds: [] }],
    apiResolution: [{ id: selected.id, providerId: "example.files" }],
  });
  try {
    expect(
      (await resolveInstalledApiProvider(selected.id, context, new AbortController().signal))
        ?.client,
    ).toBe(winner);
    expect(unrelated.discoverApis).not.toHaveBeenCalled();
  } finally {
    stops.forEach((stop) => stop());
    setInstalledApiPolicy("api-env", null);
  }
});

it("falls back when the only provider is disabled and nothing was selected", async () => {
  const missing = { code: "missing-api", detail: "No available API provider", relatedIds: [] };
  const disabledEnv = { ...context, resource: { ...context.resource, environmentId: "gone-env" } };
  setInstalledApiPolicy("gone-env", {
    apiSelections: [],
    apiResolution: [{ id: selected.id, reason: missing }],
  });
  // An unrelated enabled plugin still discovers the disabled provider's entry.
  const stop = registerInstalledApiClient(
    "gone-env",
    "other",
    client([{ ...selected, health: "unavailable", selected: false, reason: missing }]),
  );
  try {
    expect(
      await resolveInstalledApiProvider(selected.id, disabledEnv, new AbortController().signal),
    ).toBeNull();
    stop();
    expect(
      await resolveInstalledApiProvider(selected.id, disabledEnv, new AbortController().signal),
    ).toBeNull();
    // An explicit selection stays honest rather than silently falling back.
    setInstalledApiPolicy("gone-env", {
      apiSelections: [{ id: selected.id, providerId: "example.files", fallbackProviderIds: [] }],
      apiResolution: [{ id: selected.id, reason: missing }],
    });
    await expect(
      resolveInstalledApiProvider(selected.id, disabledEnv, new AbortController().signal),
    ).rejects.toThrow("No available API provider");
  } finally {
    stop();
    setInstalledApiPolicy("gone-env", null);
  }
});
