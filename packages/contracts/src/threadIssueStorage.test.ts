import { describe, expect, expectTypeOf, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { CommandId, ProjectId } from "./baseSchemas.ts";
import { ThreadIssueLink, IssueTrackerKind } from "./issue.ts";

const link = {
  projectId: "project",
  tracker: "linear",
  host: "linear.app",
  scope: "acme/ENG",
  key: "ENG-7",
  url: "https://linear.app/acme/issue/ENG-7",
  source: "agent",
  linkedAt: "2026-10-15T00:00:00Z",
  linkId: "generation-B",
  snapshot: null,
};
const encode = Schema.encodeUnknownSync(ThreadIssueLink);
const decode = Schema.decodeUnknownSync(ThreadIssueLink);
const oldProject = Schema.decodeUnknownSync(Schema.Struct({ projectId: Schema.String }));

describe("saved thread account identities", () => {
  it("keeps default storage bytes and constructor metadata", () => {
    expect(encode(link)).toEqual(link);
    expect(oldProject(encode(link))).toEqual({ projectId: "project" });
    const typed = ThreadIssueLink.make({
      ...link,
      projectId: ProjectId.make("project"),
      tracker: IssueTrackerKind.make("linear"),
      source: "agent",
      linkId: CommandId.make("generation-B"),
    });
    expectTypeOf(typed).toEqualTypeOf<ThreadIssueLink>();
  });
  it.each(["Account", "account"])(
    "preserves %s and generation while old project readers refuse",
    (connectionId) => {
      const input = { ...link, connectionId };
      const stored = encode(input);
      expect(stored).toEqual({ ...link, projectId: { value: "project", connectionId } });
      expect(decode(JSON.parse(JSON.stringify(stored)))).toEqual(input);
      expect(() => oldProject(stored)).toThrow();
      expect(() => decode(input)).toThrow();
    },
  );
});
