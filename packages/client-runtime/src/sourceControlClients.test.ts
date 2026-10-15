import { describe, expect, it } from "vite-plus/test";

import { sourceControlClients } from "./sourceControlClients.ts";

describe("sourceControlClients", () => {
  it("reads a missing kind as the first host and an unshipped kind as the generic one", () => {
    expect(sourceControlClients.get(undefined).kind).toBe("github");
    expect(sourceControlClients.get("forkhost").kind).toBe("unknown");
  });

  it("gives a change request URL to the first host whose shape it has", () => {
    // GitCafe and Forgejo share `/pulls/`; GitCafe only claims its own hostnames.
    const kindOf = (url: string) => sourceControlClients.findByChangeRequestUrl(url)?.kind;
    expect(kindOf("https://git.cafe/acme/web/pulls/7")).toBe("gitcafe");
    expect(kindOf("https://codeberg.org/acme/web/pulls/7")).toBe("forgejo");
  });

  it("gives Tangled its own hostnames even though Forgejo claims /pulls/ everywhere", () => {
    const kindOf = (url: string) => sourceControlClients.findByChangeRequestUrl(url)?.kind;
    expect(kindOf("https://tangled.org/acme.example/web/pulls/7")).toBe("tangled");
    expect(kindOf("https://knot1.tangled.sh/acme.example/web/pulls/7")).toBe("tangled");
    // A knot the appview does not serve still falls through to the host that claims any domain.
    expect(kindOf("https://forge.example/acme/web/pulls/7")).toBe("forgejo");
  });

  it("offers Tangled no change request actions, because no server provider backs them", () => {
    expect(sourceControlClients.get("tangled").changeRequestActions.size).toBe(0);
    // `tg pr checkout` takes a record key, not the number a pull request URL shows.
    expect(
      sourceControlClients.get("tangled").checkoutCommand({ number: 7, headBranch: "f" }),
    ).toBeNull();
  });
});
