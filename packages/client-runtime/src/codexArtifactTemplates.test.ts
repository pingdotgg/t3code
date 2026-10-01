import { describe, expect, it } from "vite-plus/test";

import {
  appendCodexArtifactTemplateUsePrompt,
  codexArtifactTemplatePresentationLabel,
  codexArtifactTemplateUsePrompt,
  resolveCodexArtifactTemplate,
  type CodexArtifactTemplate,
} from "./codexArtifactTemplates.js";

const HELLO_WORLD_TEMPLATE: CodexArtifactTemplate = {
  artifactKind: "document",
  displayName: "Hello World",
  skillDirectory: "/Users/test/.codex/skills/artifact-template-hello-world",
  skillName: "artifact-template-hello-world",
};

describe("artifact template presentation", () => {
  it("shares labels and copy text across clients", () => {
    expect(codexArtifactTemplatePresentationLabel("document")).toBe("Document template");
  });
});

describe("resolveCodexArtifactTemplate", () => {
  it("accepts the template metadata emitted by Codex", () => {
    expect(
      resolveCodexArtifactTemplate({
        artifact_kind: "document",
        display_name: "  Hello World  ",
        skill_directory: "/Users/test/.codex/skills/artifact-template-hello-world",
        skill_name: "artifact-template-hello-world",
      }),
    ).toEqual(HELLO_WORLD_TEMPLATE);
  });

  it.each([
    String.raw`C:\Users\test\.codex\skills\artifact-template-hello-world`,
    String.raw`\\server\share\artifact-template-hello-world`,
    "//server/share/artifact-template-hello-world",
  ])("accepts absolute Windows skill directories: %s", (skillDirectory) => {
    expect(
      resolveCodexArtifactTemplate({
        artifact_kind: "image",
        display_name: "Reference image",
        gallery_kind: "product-design",
        skill_directory: skillDirectory,
        skill_name: "artifact-template-reference-image",
      }),
    ).toMatchObject({
      artifactKind: "image",
      galleryKind: "product-design",
      skillDirectory,
    });
  });

  it.each([
    { artifact_kind: "unknown" },
    { display_name: " " },
    { skill_directory: "relative/template" },
    { skill_name: "hello-world" },
    { gallery_kind: null },
    { gallery_kind: "unknown" },
  ])("rejects malformed template metadata: %o", (override) => {
    expect(
      resolveCodexArtifactTemplate({
        artifact_kind: "document",
        display_name: "Hello World",
        skill_directory: "/templates/hello-world",
        skill_name: "artifact-template-hello-world",
        ...override,
      }),
    ).toBeNull();
  });
});

describe("codexArtifactTemplateUsePrompt", () => {
  it("builds the same document follow-up shape as Codex", () => {
    expect(codexArtifactTemplateUsePrompt(HELLO_WORLD_TEMPLATE)).toBe(
      "Create a document using this $artifact-template-hello-world about…",
    );
  });

  it("uses the artifact-specific image wording", () => {
    expect(
      codexArtifactTemplateUsePrompt({
        ...HELLO_WORLD_TEMPLATE,
        artifactKind: "image",
      }),
    ).toBe("Create an image using this $artifact-template-hello-world of…");
  });
});

describe("appendCodexArtifactTemplateUsePrompt", () => {
  const prompt = "Create a document using this $artifact-template-hello-world about…";

  it("adds the prompt to an empty draft", () => {
    expect(appendCodexArtifactTemplateUsePrompt("", HELLO_WORLD_TEMPLATE)).toBe(prompt);
  });

  it("preserves existing draft text", () => {
    expect(appendCodexArtifactTemplateUsePrompt("Write about otters", HELLO_WORLD_TEMPLATE)).toBe(
      `Write about otters ${prompt}`,
    );
  });

  it.each([prompt, `${prompt}\n`, `Notes\n\n${prompt}`])(
    "does not append the same final prompt twice: %s",
    (draft) => {
      expect(appendCodexArtifactTemplateUsePrompt(draft, HELLO_WORLD_TEMPLATE)).toBe(draft);
    },
  );

  it("does not mistake text containing the prompt for a final prompt", () => {
    const draft = `${prompt}\nAdditional instructions`;
    expect(appendCodexArtifactTemplateUsePrompt(draft, HELLO_WORLD_TEMPLATE)).toBe(
      `${draft} ${prompt}`,
    );
  });
});
