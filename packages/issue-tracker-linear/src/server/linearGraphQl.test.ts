import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { buildSchema, parse, validate } from "graphql";

import { T3AssigneeCandidates, T3Issues, T3LabelCandidates } from "./LinearApi.ts";
import {
  LinearIssueTrackerGraphQLGroup,
  T3IssueCreate,
  T3Team,
} from "./linearIssueTracker.graphql.ts";

const decodeTeam = Schema.decodeSync(T3Team.result);
const encodeCreateVariables = Schema.encodeUnknownSync(T3IssueCreate.variables);

it.effect("validates all 24 native Linear documents against the pinned schema", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const schema = buildSchema(
      yield* fs.readFileString(new URL("../../schema/linear.graphql", import.meta.url).pathname),
    );
    const operations = [
      ...LinearIssueTrackerGraphQLGroup.operations,
      T3Issues,
      T3LabelCandidates,
      T3AssigneeCandidates,
    ];
    expect(operations).toHaveLength(24);
    expect(new Set(operations.map((operation) => operation.name)).size).toBe(24);
    for (const operation of operations) {
      expect(validate(schema, parse(operation.document)), operation.name).toEqual([]);
    }
  }).pipe(Effect.provide(NodeFileSystem.layer)),
);

it("accepts future native output enums and rejects unknown input enums", () => {
  const empty = { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } };
  const decoded = decodeTeam({
    organization: { id: "organization", urlKey: "acme", templates: empty },
    teams: {
      nodes: [
        {
          id: "team",
          key: "ENG",
          name: "Engineering",
          private: false,
          visibility: "future-visibility",
          restrictedBy: null,
          ancestors: [],
          states: empty,
          labels: empty,
          members: empty,
          templates: empty,
        },
      ],
    },
    issueLabels: empty,
  });
  expect(decoded.teams.nodes[0]?.visibility).toBe("future-visibility");
  expect(() =>
    encodeCreateVariables({
      input: { teamId: "team", title: "New", slaType: "future-input" },
    }),
  ).toThrow();
});
