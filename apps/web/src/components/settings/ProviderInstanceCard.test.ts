import { describe, expect, it } from "vite-plus/test";
import type { ProviderInstanceEnvironmentVariable, ServerProviderModel } from "@t3tools/contracts";

import {
  deriveProviderModelsForDisplay,
  getProviderEnvironmentContentKey,
  isPublishedProviderEnvironmentAcknowledgedByPersisted,
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

  it("consumes a new sensitive row when its persisted save echo is redacted", () => {
    const rows = mergeEnvironmentDraftRowsForPersistedUpdate({
      rows: [
        {
          id: "provider-env-1",
          name: "API_KEY",
          value: "typed-secret",
          sensitive: true,
          valueRedacted: false,
        },
      ],
      previousEnvironment: [],
      nextEnvironment: [
        {
          name: "API_KEY",
          value: "",
          sensitive: true,
          valueRedacted: true,
        },
      ],
    });

    expect(rows).toEqual([
      {
        id: "0:API_KEY",
        name: "API_KEY",
        value: "",
        sensitive: true,
        valueRedacted: true,
      },
    ]);
  });

  it("consumes an existing sensitive row when its persisted save echo is redacted", () => {
    const rows = mergeEnvironmentDraftRowsForPersistedUpdate({
      rows: [
        {
          id: "0:API_KEY",
          name: "API_KEY",
          value: "updated-secret",
          sensitive: true,
          valueRedacted: false,
        },
      ],
      previousEnvironment: [
        {
          name: "API_KEY",
          value: "previous-secret",
          sensitive: true,
        },
      ],
      nextEnvironment: [
        {
          name: "API_KEY",
          value: "",
          sensitive: true,
          valueRedacted: true,
        },
      ],
    });

    expect(rows).toEqual([
      {
        id: "0:API_KEY",
        name: "API_KEY",
        value: "",
        sensitive: true,
        valueRedacted: true,
      },
    ]);
  });

  it("consumes an acknowledged sensitive save when persisted content stays redacted", () => {
    const previousEnvironment: ReadonlyArray<ProviderInstanceEnvironmentVariable> = [
      {
        name: "API_KEY",
        value: "",
        sensitive: true,
        valueRedacted: true,
      },
    ];
    const publishedEnvironment: ReadonlyArray<ProviderInstanceEnvironmentVariable> = [
      {
        name: "API_KEY",
        value: "updated-secret",
        sensitive: true,
        valueRedacted: false,
      },
    ];
    const redactedSaveEcho: ReadonlyArray<ProviderInstanceEnvironmentVariable> = [
      {
        name: "API_KEY",
        value: "",
        sensitive: true,
        valueRedacted: true,
      },
    ];

    expect(
      isPublishedProviderEnvironmentAcknowledgedByPersisted({
        publishedEnvironment,
        persistedEnvironment: redactedSaveEcho,
      }),
    ).toBe(true);

    const rows = mergeEnvironmentDraftRowsForPersistedUpdate({
      rows: [
        {
          id: "0:API_KEY",
          name: "API_KEY",
          value: "updated-secret",
          sensitive: true,
          valueRedacted: false,
        },
      ],
      previousEnvironment,
      nextEnvironment: redactedSaveEcho,
      publishedEnvironment,
    });

    expect(rows).toEqual([
      {
        id: "0:API_KEY",
        name: "API_KEY",
        value: "",
        sensitive: true,
        valueRedacted: true,
      },
    ]);
  });

  it("keeps a sensitive plaintext draft when a sibling persisted row changes", () => {
    const rows = mergeEnvironmentDraftRowsForPersistedUpdate({
      rows: [
        {
          id: "0:API_KEY",
          name: "API_KEY",
          value: "typed-secret",
          sensitive: true,
          valueRedacted: false,
        },
        {
          id: "1:BASE_URL",
          name: "BASE_URL",
          value: "https://old.example.test",
          sensitive: false,
        },
      ],
      previousEnvironment: [
        {
          name: "API_KEY",
          value: "",
          sensitive: true,
          valueRedacted: true,
        },
        {
          name: "BASE_URL",
          value: "https://old.example.test",
          sensitive: false,
        },
      ],
      nextEnvironment: [
        {
          name: "API_KEY",
          value: "",
          sensitive: true,
          valueRedacted: true,
        },
        {
          name: "BASE_URL",
          value: "https://new.example.test",
          sensitive: false,
        },
      ],
    });

    expect(rows).toEqual([
      {
        id: "0:API_KEY",
        name: "API_KEY",
        value: "typed-secret",
        sensitive: true,
        valueRedacted: false,
      },
      {
        id: "1:BASE_URL",
        name: "BASE_URL",
        value: "https://new.example.test",
        sensitive: false,
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

  it("preserves a confirmed empty local deletion when a stale persisted echo restores the row", () => {
    const rows = mergeEnvironmentDraftRowsForPersistedUpdate({
      rows: [],
      previousEnvironment: [],
      nextEnvironment: [
        {
          name: "API_KEY",
          value: "old",
          sensitive: true,
        },
      ],
      locallyDeletedEnvironmentVariables: new Map([
        [
          "API_KEY",
          {
            name: "API_KEY",
            value: "old",
            sensitive: true,
          },
        ],
      ]),
    });

    expect(rows).toEqual([]);
  });

  it("keeps a same-name server re-add when it differs from the deleted variable", () => {
    const rows = mergeEnvironmentDraftRowsForPersistedUpdate({
      rows: [],
      previousEnvironment: [],
      nextEnvironment: [
        {
          name: "API_KEY",
          value: "new",
          sensitive: true,
        },
      ],
      locallyDeletedEnvironmentVariables: new Map([
        [
          "API_KEY",
          {
            name: "API_KEY",
            value: "old",
            sensitive: true,
          },
        ],
      ]),
    });

    expect(rows).toEqual([
      {
        id: "0:API_KEY",
        name: "API_KEY",
        value: "new",
        sensitive: true,
      },
    ]);
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

  it("keeps reordered persisted rows when another variable has a local edit", () => {
    const rows = mergeEnvironmentDraftRowsForPersistedUpdate({
      rows: [
        {
          id: "0:A",
          name: "A",
          value: "local-edit",
          sensitive: false,
        },
        {
          id: "1:B",
          name: "B",
          value: "b",
          sensitive: false,
        },
      ],
      previousEnvironment: [
        {
          name: "A",
          value: "a",
          sensitive: false,
        },
        {
          name: "B",
          value: "b",
          sensitive: false,
        },
      ],
      nextEnvironment: [
        {
          name: "B",
          value: "b",
          sensitive: false,
        },
        {
          name: "A",
          value: "a",
          sensitive: false,
        },
      ],
    });

    expect(rows).toEqual([
      {
        id: "0:B",
        name: "B",
        value: "b",
        sensitive: false,
      },
      {
        id: "0:A",
        name: "A",
        value: "local-edit",
        sensitive: false,
      },
    ]);
  });
});
