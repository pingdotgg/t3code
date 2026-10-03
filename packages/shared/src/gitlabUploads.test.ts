import { describe, expect, it } from "vite-plus/test";
import { gitlabUploadSource } from "./gitlabUploads.ts";

const secret = "66dbcd21ec5d24ed6ea225176098d52b";
const context = { repositoryUrl: "http://gitlab.local/team/sub/project", host: "gl.here" };

describe("GitLab MR uploads", () => {
  it.each(["/uploads/", "uploads/"])(
    "resolves %s against the project and keeps the login host",
    (prefix) => {
      expect(gitlabUploadSource(`${prefix}${secret}/my%20clip.mp4#t=2`, context)).toEqual({
        reference: {
          origin: "http://gl.here",
          project: "team/sub/project",
          secret,
          fileName: "my clip.mp4",
        },
        url: `http://gitlab.local/team/sub/project/uploads/${secret}/my%20clip.mp4#t=2`,
      });
    },
  );

  it("preserves a copied project-ID upload, including a different host", () => {
    expect(
      gitlabUploadSource(`https://other.example/-/project/42/uploads/${secret}/shot.png`, context)
        ?.reference,
    ).toEqual({ origin: "https://other.example", project: "42", secret, fileName: "shot.png" });
    expect(
      gitlabUploadSource(`/-/project/42/uploads/${secret}/shot.png`, context)?.reference.project,
    ).toBe("42");
  });

  it.each(["image%2Epng", "a%20b.png", "caf%C3%A9.png", "UPPER.PNG"])(
    "decodes filename %s",
    (fileName) => {
      expect(
        gitlabUploadSource(`/uploads/${secret}/${fileName}`, context)?.reference.fileName,
      ).toBe(decodeURIComponent(fileName));
    },
  );

  it.each([
    "/tmp/shot.png",
    "javascript:alert(1)",
    "https://example.com/shot.png",
    `/uploads/${secret}/bad%2Fname.png`,
    `/uploads/${secret}/bad%5Cname.png`,
    `/uploads/${secret}/bad%00name.png`,
    `/uploads/${secret}/shot.png?token=secret`,
    `/uploads/${secret}/%XX.png`,
    `/uploads/short/shot.png`,
    `https://user:pass@example.com/team/project/uploads/${secret}/shot.png`,
  ])("does not sign unsupported source %s", (source) => {
    expect(gitlabUploadSource(source, context)).toBeNull();
  });
});
