import { describe, expect, it } from "vite-plus/test";

import { azureDevOpsAvatarIdentity, azureDevOpsAvatarMediaUrl } from "./azureDevOpsAvatar.ts";

const ID = "15f0488e-b980-68ca-9d71-8a387c166d09";

describe("azureDevOpsAvatarIdentity", () => {
  it("reads the organization and identity from both host shapes", () => {
    expect(
      azureDevOpsAvatarIdentity(`https://dev.azure.com/acme/_api/_common/identityImage?id=${ID}`),
    ).toEqual({ organizationUrl: "https://dev.azure.com/acme", identityId: ID });
    expect(
      azureDevOpsAvatarIdentity(
        `https://acme.visualstudio.com/_api/_common/identityImage?id=${ID.toUpperCase()}`,
      ),
    ).toEqual({ organizationUrl: "https://acme.visualstudio.com", identityId: ID });
  });

  it("rejects anything else", () => {
    for (const url of [
      `http://dev.azure.com/acme/_api/_common/identityImage?id=${ID}`,
      `https://dev.azure.com/_api/_common/identityImage?id=${ID}`,
      `https://dev.azure.com/acme/project/_api/_common/identityImage?id=${ID}`,
      `https://dev.azure.com/acme/_api/_common/identityImage?id=not-a-guid`,
      `https://evil.example/acme/_api/_common/identityImage?id=${ID}`,
      `https://evil.visualstudio.com.example/_api/_common/identityImage?id=${ID}`,
      "https://avatars.githubusercontent.com/u/1",
      "not a url",
    ]) {
      expect(azureDevOpsAvatarIdentity(url), url).toBeNull();
    }
  });

  it("claims one canonical fetch URL for every spelling of an identity image", () => {
    expect(
      azureDevOpsAvatarMediaUrl(
        new URL(
          `https://dev.azure.com/acme/_API/_common/IdentityImage?id=${ID.toUpperCase()}&size=2`,
        ),
      ),
    ).toEqual({
      fetchUrl: `https://dev.azure.com/acme/_api/_common/identityImage?id=${ID}`,
      fileName: "avatar",
      kind: "image",
    });
    expect(azureDevOpsAvatarMediaUrl(new URL("https://avatars.githubusercontent.com/u/1"))).toBe(
      null,
    );
  });
});
