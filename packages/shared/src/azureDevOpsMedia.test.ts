import { describe, expect, it } from "vite-plus/test";
import { azureDevOpsMediaLocation } from "./azureDevOpsMedia.ts";

const attachment = "/project/_apis/git/repositories/repo/pullRequests/42/attachments/demo.gif";

describe("Azure DevOps media endpoints", () => {
  it("resolves modern and legacy attachment URLs without forwarding query credentials", () => {
    const modern = azureDevOpsMediaLocation(
      `https://dev.azure.com/org${attachment}?api-version=7.1#preview`,
    );
    expect(modern).toEqual({
      organizationUrl: "https://dev.azure.com/org",
      project: "project",
      repositoryId: "repo",
      pullRequestId: "42",
      fileName: "demo.gif",
      fetchUrl: `https://dev.azure.com/org${attachment}`,
    });
    expect(
      azureDevOpsMediaLocation(`https://org.visualstudio.com/DefaultCollection${attachment}`),
    ).toEqual({
      ...modern,
      organizationUrl: "https://org.visualstudio.com/DefaultCollection",
      fetchUrl: `https://org.visualstudio.com/DefaultCollection${attachment}`,
    });
    expect(azureDevOpsMediaLocation(`https://org.visualstudio.com${attachment}`)).toEqual({
      ...modern,
      organizationUrl: "https://org.visualstudio.com",
      fetchUrl: `https://org.visualstudio.com${attachment}`,
    });
  });

  it("decodes route parameters once and keeps filenames out of filesystem paths", () => {
    expect(
      azureDevOpsMediaLocation(
        `https://dev.azure.com/org${attachment.replace("project", "My%20Project").replace("demo.gif", "demo%20%231.mp4")}`,
      ),
    ).toMatchObject({ project: "My Project", fileName: "demo #1.mp4" });
  });

  it.each([
    `http://dev.azure.com/org${attachment}`,
    `https://dev.azure.com.evil.test/org${attachment}`,
    `https://user:secret@dev.azure.com/org${attachment}`,
    `https://dev.azure.com:8443/org${attachment}`,
    `https://dev.azure.com/org${attachment.replace("demo.gif", "a%2fb.gif")}`,
    `https://dev.azure.com/org${attachment.replace("demo.gif", "a%5cb.gif")}`,
    `https://dev.azure.com/org${attachment.replace("demo.gif", "%00.gif")}`,
    "https://dev.azure.com/org/project/_git/repo/pullrequest/42",
    "https://example.test/demo.mp4",
  ])("rejects non-attachment or unsafe endpoint %s", (url) => {
    expect(azureDevOpsMediaLocation(url)).toBeNull();
  });
});
