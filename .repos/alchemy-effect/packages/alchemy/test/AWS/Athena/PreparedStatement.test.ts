import * as AWS from "@/AWS";
import { PreparedStatement } from "@/AWS/Athena/PreparedStatement.ts";
import { WorkGroup } from "@/AWS/Athena/WorkGroup.ts";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as athena from "@distilled.cloud/aws/athena";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

const wgName = "alchemy-test-athena-ps-wg";
const stmtName = "alchemy_test_prepared_stmt";

const getStatement = athena
  .getPreparedStatement({ WorkGroup: wgName, StatementName: stmtName })
  .pipe(
    Effect.map((res) => res.PreparedStatement),
    Effect.catchTag(["ResourceNotFoundException", "WorkGroupNotFound"], () =>
      Effect.succeed(undefined),
    ),
  );

test.provider(
  "lifecycle: create in a workgroup, update statement text, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Create — a named statement saved in a dedicated workgroup.
      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const wg = yield* WorkGroup("PSWorkGroup", {
            workGroupName: wgName,
          });
          return yield* PreparedStatement("Stmt", {
            statementName: stmtName,
            workGroup: wg.workGroupName,
            queryStatement: "SELECT 1 AS one",
            description: "alchemy prepared statement test",
          });
        }),
      );
      expect(deployed.statementName).toBe(stmtName);
      expect(deployed.workGroup).toBe(wgName);
      expect(deployed.queryStatement).toBe("SELECT 1 AS one");

      // Out-of-band verification via distilled.
      const created = yield* getStatement;
      expect(created?.StatementName).toBe(stmtName);
      expect(created?.QueryStatement).toBe("SELECT 1 AS one");
      expect(created?.Description).toBe("alchemy prepared statement test");

      // Canonical list() coverage.
      const provider = yield* Provider.findProvider(PreparedStatement);
      const all = yield* provider.list();
      expect(
        all.some(
          (ps) => ps.statementName === stmtName && ps.workGroup === wgName,
        ),
      ).toBe(true);

      // Update — statement text and description are updatable in place.
      yield* stack.deploy(
        Effect.gen(function* () {
          const wg = yield* WorkGroup("PSWorkGroup", {
            workGroupName: wgName,
          });
          return yield* PreparedStatement("Stmt", {
            statementName: stmtName,
            workGroup: wg.workGroupName,
            queryStatement: "SELECT 2 AS two",
            description: "updated",
          });
        }),
      );
      const updated = yield* getStatement;
      expect(updated?.QueryStatement).toBe("SELECT 2 AS two");
      expect(updated?.Description).toBe("updated");

      // Destroy — statement (and its workgroup) are gone.
      yield* stack.destroy();
      const after = yield* getStatement;
      expect(after).toBeUndefined();
    }),
  { timeout: 180_000 },
);
