import { describe, expect, it } from "vite-plus/test";

import { gitLabMediaUrl, gitLabUploadApiUrl, parseGitLabUpload } from "./gitLabMedia.ts";

const SECRET = "66dbcd21ec5d24ed6ea225176098d52b";

const media = (url: string) => gitLabMediaUrl(new URL(url));

describe("gitLabMedia", () => {
  it("maps project-path and project-id upload URLs to the upload API", () => {
    const byPath = parseGitLabUpload(
      new URL(`https://gitlab.example.com/group/sub/project/uploads/${SECRET}/my%20shot.png`),
    );
    expect(byPath && gitLabUploadApiUrl(byPath)).toBe(
      `https://gitlab.example.com/api/v4/projects/group%2Fsub%2Fproject/uploads/${SECRET}/my%20shot.png`,
    );
    const byId = parseGitLabUpload(
      new URL(`https://gitlab.example.com:8443/-/project/42/uploads/${SECRET}/demo.mp4`),
    );
    expect(byId && gitLabUploadApiUrl(byId)).toBe(
      `https://gitlab.example.com:8443/api/v4/projects/42/uploads/${SECRET}/demo.mp4`,
    );
  });

  it("drops query and fragment from the canonical URL", () => {
    expect(media(`https://gitlab.com/team/app/uploads/${SECRET}/demo.mp4?x=1#t=2`)).toEqual({
      fetchUrl: `https://gitlab.com/team/app/uploads/${SECRET}/demo.mp4`,
      fileName: "demo.mp4",
      immutable: true,
    });
  });

  it("rejects anything that is not a project upload over https", () => {
    for (const url of [
      `http://gitlab.com/team/app/uploads/${SECRET}/a.png`,
      `https://user:pw@gitlab.com/team/app/uploads/${SECRET}/a.png`,
      `https://gitlab.com/uploads/${SECRET}/a.png`,
      `https://gitlab.com/team/app/-/uploads/${SECRET}/a.png`,
      `https://gitlab.com/uploads/-/system/user/avatar/1/avatar.png`,
      `https://gitlab.com/team/app/uploads/not-a-secret/a.png`,
    ]) {
      expect(media(url), url).toBeNull();
    }
  });

  it("names the file from its decoded last segment", () => {
    expect(media(`https://gitlab.com/a/b/uploads/${SECRET}/my%20shot.png`)?.fileName).toBe(
      "my shot.png",
    );
    expect(media(`https://gitlab.com/a/b/uploads/${SECRET}/%E0%A4%A.png`)?.fileName).toBe(
      "%E0%A4%A.png",
    );
  });
});
