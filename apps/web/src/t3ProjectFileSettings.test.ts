import { T3_PROJECT_FILE_SCHEMA_URL } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildT3ProjectFile,
  createEmptyT3ProjectFileScriptDraft,
  createT3ProjectFileDraft,
  createT3ProjectFileDraftState,
  reconcileT3ProjectFileDraftState,
  t3ProjectFileDraftKey,
  updateT3ProjectFileScriptPreviewUrl,
} from "./t3ProjectFileSettings";

describe("t3 project file settings", () => {
  it("creates an editable draft from the existing schema fields", () => {
    expect(
      createT3ProjectFileDraft({
        $schema: T3_PROJECT_FILE_SCHEMA_URL,
        iconPath: "assets/icon.svg",
        scripts: [
          {
            name: "Dev",
            command: "vp run dev",
            previewUrl: "http://localhost:5733",
            autoOpenPreview: true,
          },
        ],
      }),
    ).toEqual({
      schemaUrl: T3_PROJECT_FILE_SCHEMA_URL,
      iconPath: "assets/icon.svg",
      scripts: [
        {
          id: "file-0",
          name: "Dev",
          command: "vp run dev",
          icon: "play",
          runOnWorktreeCreate: false,
          previewUrl: "http://localhost:5733",
          autoOpenPreview: true,
        },
      ],
    });
  });

  it("preserves auto-open independently of a preview URL", () => {
    const result = buildT3ProjectFile({
      schemaUrl: T3_PROJECT_FILE_SCHEMA_URL,
      iconPath: " assets/icon.svg ",
      scripts: [
        {
          id: "setup",
          name: " Setup ",
          command: " vp install ",
          icon: "configure",
          runOnWorktreeCreate: true,
          previewUrl: "",
          autoOpenPreview: true,
        },
      ],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.file).toEqual({
      $schema: T3_PROJECT_FILE_SCHEMA_URL,
      iconPath: "assets/icon.svg",
      scripts: [
        {
          name: "Setup",
          command: "vp install",
          icon: "configure",
          runOnWorktreeCreate: true,
          autoOpenPreview: true,
        },
      ],
    });
    expect(JSON.parse(result.contents)).toEqual(result.file);
    expect(result.contents.endsWith("\n")).toBe(true);
  });

  it("roundtrips auto-open without a preview URL while editing another field", () => {
    const draft = createT3ProjectFileDraft({
      $schema: T3_PROJECT_FILE_SCHEMA_URL,
      scripts: [
        {
          name: "Dev",
          command: "vp run dev",
          autoOpenPreview: true,
        },
      ],
    });
    const result = buildT3ProjectFile({ ...draft, iconPath: "assets/icon.svg" });

    expect(draft.scripts[0]).toMatchObject({
      previewUrl: "",
      autoOpenPreview: true,
    });
    expect(result).toMatchObject({
      ok: true,
      file: {
        iconPath: "assets/icon.svg",
        scripts: [
          {
            name: "Dev",
            command: "vp run dev",
            autoOpenPreview: true,
          },
        ],
      },
    });
    if (result.ok) {
      expect(result.file.scripts?.[0]).not.toHaveProperty("previewUrl");
    }
  });

  it("turns off auto-open when a user clears the preview URL", () => {
    const script = {
      ...createEmptyT3ProjectFileScriptDraft(),
      previewUrl: "http://localhost:5733",
      autoOpenPreview: true,
    };

    expect(updateT3ProjectFileScriptPreviewUrl(script, " ")).toMatchObject({
      previewUrl: " ",
      autoOpenPreview: false,
    });
  });

  it("omits a cleared icon path", () => {
    const result = buildT3ProjectFile({
      schemaUrl: "",
      iconPath: " ",
      scripts: [],
    });

    expect(result).toMatchObject({
      ok: true,
      file: {
        $schema: T3_PROJECT_FILE_SCHEMA_URL,
        scripts: [],
      },
    });
    if (result.ok) {
      expect("iconPath" in result.file).toBe(false);
    }
  });

  it("rejects incomplete shared actions before writing the file", () => {
    expect(
      buildT3ProjectFile({
        schemaUrl: T3_PROJECT_FILE_SCHEMA_URL,
        iconPath: "",
        scripts: [createEmptyT3ProjectFileScriptDraft()],
      }),
    ).toEqual({
      ok: false,
      error: "Shared action 1 needs a name.",
    });
  });
});

describe("t3 project file draft reconciliation", () => {
  const initialSource = createT3ProjectFileDraft({
    $schema: T3_PROJECT_FILE_SCHEMA_URL,
    iconPath: "assets/original.svg",
    scripts: [],
  });

  it("adopts a refreshed source when the draft is clean", () => {
    const refreshedSource = { ...initialSource, iconPath: "assets/refreshed.svg" };
    const reconciled = reconcileT3ProjectFileDraftState(
      createT3ProjectFileDraftState(initialSource),
      refreshedSource,
    );

    expect(reconciled).toEqual(createT3ProjectFileDraftState(refreshedSource));
  });

  it("preserves a dirty draft and validation across equivalent refreshes", () => {
    const dirtyDraft = { ...initialSource, iconPath: "assets/local.svg" };
    const current = {
      draft: dirtyDraft,
      source: initialSource,
      validationError: "Local validation failure",
    };
    const reconciled = reconcileT3ProjectFileDraftState(current, { ...initialSource });

    expect(reconciled.draft).toBe(dirtyDraft);
    expect(reconciled.source).toEqual(initialSource);
    expect(reconciled.validationError).toBe("Local validation failure");
  });

  it("preserves dirty edits while advancing the Reset baseline to a changed source", () => {
    const dirtyDraft = { ...initialSource, iconPath: "assets/local.svg" };
    const refreshedSource = { ...initialSource, iconPath: "assets/remote.svg" };
    const reconciled = reconcileT3ProjectFileDraftState(
      {
        draft: dirtyDraft,
        source: initialSource,
        validationError: "Local validation failure",
      },
      refreshedSource,
    );

    expect(reconciled.draft).toBe(dirtyDraft);
    expect(reconciled.source).toBe(refreshedSource);
    expect(reconciled.validationError).toBe("Local validation failure");
    expect(t3ProjectFileDraftKey(reconciled.draft)).not.toBe(
      t3ProjectFileDraftKey(reconciled.source),
    );
  });

  it("becomes clean when a refresh matches the local edits", () => {
    const dirtyDraft = { ...initialSource, iconPath: "assets/local.svg" };
    const refreshedSource = { ...dirtyDraft };
    const reconciled = reconcileT3ProjectFileDraftState(
      {
        draft: dirtyDraft,
        source: initialSource,
        validationError: "Stale validation failure",
      },
      refreshedSource,
    );

    expect(reconciled).toEqual(createT3ProjectFileDraftState(refreshedSource));
    expect(t3ProjectFileDraftKey(reconciled.draft)).toBe(t3ProjectFileDraftKey(reconciled.source));
  });

  it("reconciles matching persisted scripts while preserving their local rendering IDs", () => {
    const localScript = {
      ...createEmptyT3ProjectFileScriptDraft("new-0"),
      name: "Dev",
      command: "vp run dev",
      icon: "debug" as const,
      runOnWorktreeCreate: true,
      previewUrl: "http://localhost:5733",
      autoOpenPreview: true,
    };
    const dirtyDraft = { ...initialSource, scripts: [localScript] };
    const refreshedSource = {
      ...initialSource,
      scripts: [{ ...localScript, id: "file-0" }],
    };
    const reconciled = reconcileT3ProjectFileDraftState(
      {
        draft: dirtyDraft,
        source: initialSource,
        validationError: "Stale validation failure",
      },
      refreshedSource,
    );

    expect(reconciled).toEqual({
      draft: dirtyDraft,
      source: refreshedSource,
      validationError: null,
    });
    expect(reconciled.draft.scripts[0]?.id).toBe("new-0");
    expect(t3ProjectFileDraftKey(reconciled.draft)).toBe(t3ProjectFileDraftKey(reconciled.source));
  });

  it("keeps a draft dirty when a persisted script field differs after refresh", () => {
    const localScript = {
      ...createEmptyT3ProjectFileScriptDraft("new-0"),
      name: "Dev",
      command: "vp run dev",
    };
    const dirtyDraft = { ...initialSource, scripts: [localScript] };
    const refreshedSource = {
      ...initialSource,
      scripts: [{ ...localScript, id: "file-0", command: "vp run dev --host" }],
    };
    const reconciled = reconcileT3ProjectFileDraftState(
      {
        draft: dirtyDraft,
        source: initialSource,
        validationError: "Local validation failure",
      },
      refreshedSource,
    );

    expect(reconciled).toEqual({
      draft: dirtyDraft,
      source: refreshedSource,
      validationError: "Local validation failure",
    });
    expect(t3ProjectFileDraftKey(reconciled.draft)).not.toBe(
      t3ProjectFileDraftKey(reconciled.source),
    );
  });

  it("includes script order in the semantic draft key", () => {
    const firstScript = {
      ...createEmptyT3ProjectFileScriptDraft("new-0"),
      name: "Setup",
      command: "vp install",
    };
    const secondScript = {
      ...createEmptyT3ProjectFileScriptDraft("new-1"),
      name: "Dev",
      command: "vp run dev",
    };
    const orderedDraft = { ...initialSource, scripts: [firstScript, secondScript] };
    const reorderedDraft = {
      ...initialSource,
      scripts: [
        { ...secondScript, id: "file-0" },
        { ...firstScript, id: "file-1" },
      ],
    };

    expect(t3ProjectFileDraftKey(orderedDraft)).not.toBe(t3ProjectFileDraftKey(reorderedDraft));
  });

  it("includes auto-open without a preview URL in the semantic draft key", () => {
    const script = {
      ...createEmptyT3ProjectFileScriptDraft("new-0"),
      name: "Dev",
      command: "vp run dev",
    };
    const disabledDraft = { ...initialSource, scripts: [script] };
    const enabledDraft = {
      ...initialSource,
      scripts: [{ ...script, autoOpenPreview: true }],
    };

    expect(t3ProjectFileDraftKey(enabledDraft)).not.toBe(t3ProjectFileDraftKey(disabledDraft));
  });
});
