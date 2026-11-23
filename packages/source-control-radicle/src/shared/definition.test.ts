import { describe, expect, it } from "vite-plus/test";

import {
  definition,
  parseRadicleRemote,
  parseRid,
  patchNumberFromId,
  patchPrefixFromNumber,
} from "./definition.ts";

const RID = "zGacgtCptk9cPMt7vDpUKwVALZvZ";
const NID = "z6MkjPKXqDPBHhFBm6YfXqKt71BmW9Rpom55j3jhvP3JkaEx";
const PATCH = "57045d7f5e43f0bc09a18504970d2993b0c16edc";

describe("patch numbers", () => {
  it("round-trips the ID prefix `rad` resolves", () => {
    const number = patchNumberFromId(PATCH);
    expect(Number.isSafeInteger(number)).toBe(true);
    expect(patchPrefixFromNumber(number)).toBe(PATCH.slice(0, 10));
  });

  it("keeps leading zeros", () => {
    expect(patchPrefixFromNumber(patchNumberFromId("0000a1b2c3ffff"))).toBe("0000a1b2c3");
  });
});

describe("remotes", () => {
  it("reads the repository from fetch, push and clone forms, keeping its case", () => {
    expect(parseRadicleRemote(`rad://${RID}`)).toEqual({ rid: RID, nid: null });
    expect(parseRadicleRemote(`rad://${RID}/${NID}`)).toEqual({ rid: RID, nid: NID });
    expect(parseRadicleRemote(`rad:${RID}`)).toEqual({ rid: RID, nid: null });
    expect(parseRid(`rad:${RID}`)).toBe(RID);
  });

  it("claims only Radicle remotes", () => {
    const remote = (remoteUrl: string) => ({ remoteUrl, host: "x", hostname: "x" });
    expect(definition.recognizeRemote(remote(`rad://${RID}/${NID}`))?.kind).toBe("radicle");
    expect(definition.recognizeRemote(remote("git@github.com:owner/repo.git"))).toBeNull();
    expect(definition.recognizeRemote(remote("https://github.com/owner/repo"))).toBeNull();
  });
});

describe("patch links", () => {
  it("builds and parses explorer links by ID prefix", () => {
    const number = patchNumberFromId(PATCH);
    const url = definition.changeRequestUrl({
      host: "radicle",
      repository: `rad:${RID}`,
      number,
    });
    expect(url).toBe(
      `https://radicle.network/nodes/seed.radicle.dev/rad:${RID}/patches/${PATCH.slice(0, 10)}`,
    );
    expect(definition.parseChangeRequestUrl(new URL(url!))).toMatchObject({
      host: "radicle",
      repository: RID.toLowerCase(),
      number,
    });
  });

  it("parses a full patch ID on any explorer host", () => {
    const link = definition.parseChangeRequestUrl(
      new URL(`https://explorer.example/nodes/seed.example:8080/rad:${RID}/patches/${PATCH}`),
    );
    expect(link?.number).toBe(patchNumberFromId(PATCH));
    expect(link?.repositoryUrl).toBe(`https://explorer.example/nodes/seed.example:8080/rad:${RID}`);
  });

  it("refuses short IDs it cannot turn into a number", () => {
    expect(
      definition.parseChangeRequestUrl(
        new URL(`https://radicle.network/nodes/n/rad:${RID}/patches/57045d7`),
      ),
    ).toBeNull();
  });

  it("matches a link to the project by repository ID", () => {
    const identity = {
      canonicalKey: `radicle/${RID.toLowerCase()}`,
      locator: { source: "git-remote" as const, remoteName: "rad", remoteUrl: `rad://${RID}` },
      name: RID,
    };
    const link = { host: "radicle", repository: RID.toLowerCase(), number: 1 };
    expect(definition.isChangeRequestInRepository(identity, link)).toBe(true);
    expect(
      definition.isChangeRequestInRepository(identity, { ...link, repository: "zother" }),
    ).toBe(false);
    expect(definition.repositorySelector({ provider: definition.kind, name: RID })).toBe(
      `rad:${RID}`,
    );
  });
});

it("reads the patch a checkout command names", () => {
  expect(definition.checkoutCommandArgument("rad patch checkout 57045d7f5e")).toBe("57045d7f5e");
  expect(definition.checkoutCommand({ number: patchNumberFromId(PATCH), headBranch: "x" })).toBe(
    `rad patch checkout ${PATCH.slice(0, 10)}`,
  );
});
