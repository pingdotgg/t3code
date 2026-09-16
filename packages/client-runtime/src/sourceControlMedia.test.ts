import { describe, expect, it } from "vite-plus/test";

import { classifyMarkdownImageSource } from "./markdownImages.ts";

const secret = "e347d7ff85358d19b72222f1174b9a4b";
const context = { provider: "gitlab", repositoryUrl: "https://git.example/acme/project" } as const;

describe("source-control markdown images", () => {
  it("resolves a relative MR upload against its repository, without a thread", () => {
    expect(classifyMarkdownImageSource(`/uploads/${secret}/shot.png`, null, context)).toMatchObject(
      {
        _tag: "SourceControlMedia",
        reference: {
          _tag: "gitlab",
          origin: "https://git.example",
          project: "acme/project",
          secret,
          fileName: "shot.png",
        },
      },
    );
  });

  it("preserves another project's upload ID in an MR and in ordinary chat", () => {
    for (const imageContext of [context, undefined]) {
      expect(
        classifyMarkdownImageSource(
          `https://git.example/-/project/123/uploads/${secret}/shot%20one.png`,
          null,
          imageContext,
        ),
      ).toMatchObject({
        _tag: "SourceControlMedia",
        reference: {
          _tag: "gitlab",
          origin: "https://git.example",
          project: "123",
          secret,
          fileName: "shot one.png",
        },
      });
    }
  });

  it("uses the MR login host when GitLab advertises its canonical hostname", () => {
    const imageContext = {
      provider: "gitlab",
      repositoryUrl: "http://gitlab.local/root/repro",
      host: "gl.here",
    };
    expect(
      classifyMarkdownImageSource(`/uploads/${secret}/shot.png`, null, imageContext),
    ).toMatchObject({
      _tag: "SourceControlMedia",
      reference: { origin: "http://gl.here", project: "root/repro" },
      uri: `http://gitlab.local/root/repro/uploads/${secret}/shot.png`,
    });
    expect(
      classifyMarkdownImageSource(
        `https://other.gitlab/root/repro/uploads/${secret}/shot.png`,
        null,
        imageContext,
      ),
    ).toMatchObject({ reference: { origin: "https://other.gitlab" } });
  });

  it("preserves numeric project IDs on GitLab installations under a subfolder", () => {
    expect(
      classifyMarkdownImageSource(
        `https://git.example/gitlab/-/project/123/uploads/${secret}/shot.png`,
      ),
    ).toMatchObject({ _tag: "SourceControlMedia", reference: { project: "123" } });
  });

  it("recognizes GitLab video uploads for authenticated delivery", () => {
    const uri = `https://git.example/acme/project/uploads/${secret}/demo.mp4`;
    expect(classifyMarkdownImageSource(uri)).toMatchObject({
      _tag: "SourceControlMedia",
      uri,
      reference: { fileName: "demo.mp4" },
    });
  });

  it("recognizes project-qualified GitLab links in chat", () => {
    expect(
      classifyMarkdownImageSource(
        `http://gl.here:8080/team/subgroup/repo/uploads/${secret}/shot.png`,
      ),
    ).toMatchObject({
      _tag: "SourceControlMedia",
      reference: {
        _tag: "gitlab",
        origin: "http://gl.here:8080",
        project: "team/subgroup/repo",
        secret,
      },
    });
  });

  it("keeps an unqualified upload local when no GitLab context identifies it", () => {
    expect(classifyMarkdownImageSource(`/uploads/${secret}/shot.png`, "/workspace")).toEqual({
      _tag: "WorkspaceFile",
      path: `/uploads/${secret}/shot.png`,
    });
  });

  it("recognizes GitHub uploads without caller-specific logic", () => {
    const url = "https://github.com/user-attachments/assets/1234-abcd";
    expect(classifyMarkdownImageSource(url)).toEqual({
      _tag: "SourceControlMedia",
      reference: { _tag: "github", url },
      uri: url,
    });
  });

  it.each(["..", "%2Fsecret", "%5Csecret", "%00", "%invalid"])(
    "does not authorize an invalid upload filename: %s",
    (name) => {
      expect(
        classifyMarkdownImageSource(`https://git.example/-/project/123/uploads/${secret}/${name}`)
          ._tag,
      ).not.toBe("SourceControlMedia");
    },
  );
});
