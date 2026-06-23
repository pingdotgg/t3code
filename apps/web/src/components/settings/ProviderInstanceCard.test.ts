import { describe, expect, it } from "vite-plus/test";
import type { ProviderInstanceEnvironmentVariable, ServerProviderModel } from "@t3tools/contracts";

import {
  deriveProviderModelsForDisplay,
  getProviderEnvironmentContentKey,
  mergeEnvironmentDraftRowsForPersistedUpdate,
} from "./ProviderInstanceCard";

describe("deriveProviderModelsForDisplay", () => {
  it("uses current config custom models instead of stale live custom rows", () => {
    const liveModels: ReadonlyArray<ServerProviderModel> = [
      {
        slug: "server-model",
        name: "Server Model",
        isCustom: false,
        capabilities: null,
      },
      {
        slug: "removed-custom",
        name: "Removed Custom",
        isCustom: true,
        capabilities: null,
      },
      {
        slug: "kept-custom",
        name: "Kept Custom",
        isCustom: true,
        capabilities: null,
      },
    ];

    expect(
      deriveProviderModelsForDisplay({
        liveModels,
        customModels: ["kept-custom"],
      }).map((model) => model.slug),
    ).toEqual(["server-model", "kept-custom"]);
  });
});

describe("getProviderEnvironmentContentKey", () => {
  const secretVariable: ProviderInstanceEnvironmentVariable = {
    name: "API_KEY",
    value: "stored-secret",
    sensitive: true,
    valueRedacted: true,
  };
  const baseUrlVariable: ProviderInstanceEnvironmentVariable = {
    name: "BASE_URL",
    value: "https://example.test",
    sensitive: false,
  };
  const environment: ReadonlyArray<ProviderInstanceEnvironmentVariable> = [
    secretVariable,
    baseUrlVariable,
  ];

  it("keeps the same key for the same persisted content in a different array", () => {
    expect(getProviderEnvironmentContentKey(environment)).toBe(
      getProviderEnvironmentContentKey(environment.map((variable) => ({ ...variable }))),
    );
  });

  it("changes the key when persisted values change", () => {
    expect(getProviderEnvironmentContentKey(environment)).not.toBe(
      getProviderEnvironmentContentKey([
        { ...secretVariable, value: "updated-secret" },
        baseUrlVariable,
      ]),
    );
  });

  it("changes the key when persisted rows are removed", () => {
    expect(getProviderEnvironmentContentKey(environment)).not.toBe(
      getProviderEnvironmentContentKey(environment.slice(0, 1)),
    );
  });

  it("changes the key when persisted redaction state changes", () => {
    expect(getProviderEnvironmentContentKey(environment)).not.toBe(
      getProviderEnvironmentContentKey([
        { ...secretVariable, valueRedacted: false },
        baseUrlVariable,
      ]),
    );
  });
});

describe("mergeEnvironmentDraftRowsForPersistedUpdate", () => {
  it("keeps a newer local draft when an older persisted echo arrives", () => {
    const previousEnvironment: ReadonlyArray<ProviderInstanceEnvironmentVariable> = [
      {
        name: "API_KEY",
        value: "old",
        sensitive: true,
      },
    ];
    const olderEcho: ReadonlyArray<ProviderInstanceEnvironmentVariable> = [
      {
        name: "API_KEY",
        value: "first-edit",
        sensitive: true,
      },
    ];

    const rows = mergeEnvironmentDraftRowsForPersistedUpdate({
      rows: [
        {
          id: "0:API_KEY",
          name: "API_KEY",
          value: "second-edit",
          sensitive: true,
        },
      ],
      previousEnvironment,
      nextEnvironment: olderEcho,
    });

    expect(rows).toEqual([
      {
        id: "0:API_KEY",
        name: "API_KEY",
        value: "second-edit",
        sensitive: true,
      },
    ]);
  });

  it("keeps unpublished add rows when persisted settings change", () => {
    const previousEnvironment: ReadonlyArray<ProviderInstanceEnvironmentVariable> = [
      {
        name: "API_KEY",
        value: "old",
        sensitive: true,
      },
    ];
    const nextEnvironment: ReadonlyArray<ProviderInstanceEnvironmentVariable> = [
      {
        name: "API_KEY",
        value: "new",
        sensitive: true,
      },
    ];

    const rows = mergeEnvironmentDraftRowsForPersistedUpdate({
      rows: [
        {
          id: "0:API_KEY",
          name: "API_KEY",
          value: "old",
          sensitive: true,
        },
        {
          id: "provider-env-1",
          name: "",
          value: "",
          sensitive: true,
        },
      ],
      previousEnvironment,
      nextEnvironment,
    });

    expect(rows).toEqual([
      {
        id: "0:API_KEY",
        name: "API_KEY",
        value: "new",
        sensitive: true,
      },
      {
        id: "provider-env-1",
        name: "",
        value: "",
        sensitive: true,
      },
    ]);
  });

  it("drops a local add row once the persisted save echo arrives", () => {
    const rows = mergeEnvironmentDraftRowsForPersistedUpdate({
      rows: [
        {
          id: "provider-env-1",
          name: "API_KEY",
          value: "new-secret",
          sensitive: true,
        },
      ],
      previousEnvironment: [],
      nextEnvironment: [
        {
          name: "API_KEY",
          value: "new-secret",
          sensitive: true,
        },
      ],
    });

    expect(rows).toEqual([
      {
        id: "0:API_KEY",
        name: "API_KEY",
        value: "new-secret",
        sensitive: true,
      },
    ]);
  });

  it("preserves a local deletion when a stale persisted echo still contains the row", () => {
    const previousEnvironment: ReadonlyArray<ProviderInstanceEnvironmentVariable> = [
      {
        name: "API_KEY",
        value: "old",
        sensitive: true,
      },
    ];

    const rows = mergeEnvironmentDraftRowsForPersistedUpdate({
      rows: [],
      previousEnvironment,
      nextEnvironment: previousEnvironment,
    });

    expect(rows).toEqual([]);
  });

  it("keeps a new persisted row when a different previous-index draft row was deleted", () => {
    const rows = mergeEnvironmentDraftRowsForPersistedUpdate({
      rows: [],
      previousEnvironment: [
        {
          name: "API_KEY",
          value: "old",
          sensitive: true,
        },
      ],
      nextEnvironment: [
        {
          name: "BASE_URL",
          value: "https://example.test",
          sensitive: false,
        },
      ],
    });

    expect(rows).toEqual([
      {
        id: "0:BASE_URL",
        name: "BASE_URL",
        value: "https://example.test",
        sensitive: false,
      },
    ]);
  });

  it("matches a renamed variable save echo without duplicating the draft row", () => {
    const rows = mergeEnvironmentDraftRowsForPersistedUpdate({
      rows: [
        {
          id: "0:OLD_API_KEY",
          name: "NEW_API_KEY",
          value: "secret",
          sensitive: true,
        },
      ],
      previousEnvironment: [
        {
          name: "OLD_API_KEY",
          value: "secret",
          sensitive: true,
        },
      ],
      nextEnvironment: [
        {
          name: "NEW_API_KEY",
          value: "secret",
          sensitive: true,
        },
      ],
    });

    expect(rows).toEqual([
      {
        id: "0:NEW_API_KEY",
        name: "NEW_API_KEY",
        value: "secret",
        sensitive: true,
      },
    ]);
  });
});
