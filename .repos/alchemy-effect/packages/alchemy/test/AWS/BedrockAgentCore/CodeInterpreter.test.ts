import * as AWS from "@/AWS";
import { CodeInterpreter } from "@/AWS/BedrockAgentCore";
import * as Test from "@/Test/Alchemy";
import * as control from "@distilled.cloud/aws/bedrock-agentcore-control";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

// Ungated typed-error probe: prove the distilled error union carries the
// not-found tag this provider's read/delete paths depend on.
test.provider(
  "getCodeInterpreter on a nonexistent id fails with ResourceNotFoundException",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        control.getCodeInterpreter({
          codeInterpreterId: "alchemy_nonexistent_probe-0000000000",
        }),
      );
      expect(error._tag).toBe("ResourceNotFoundException");
    }),
);

const assertInterpreterGone = (codeInterpreterId: string) =>
  Effect.gen(function* () {
    const status = yield* control
      .getCodeInterpreter({ codeInterpreterId })
      .pipe(
        Effect.map((r) => r.status as string),
        Effect.catchTag("ResourceNotFoundException", () =>
          Effect.succeed("DELETED" as string),
        ),
      );
    if (status !== "DELETED") {
      return yield* Effect.fail(
        new Error(`interpreter still live (status: ${status})`),
      );
    }
  }).pipe(
    Effect.retry({
      schedule: Schedule.max([
        Schedule.fixed("3 seconds"),
        Schedule.recurs(10),
      ]),
    }),
  );

test.provider(
  "create sandbox interpreter, verify, replace on network change, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // create (SANDBOX default)
      const { interpreter } = yield* stack.deploy(
        Effect.gen(function* () {
          const interpreter = yield* CodeInterpreter("Sandbox", {
            tags: { fixture: "agentcore-code-interpreter" },
          });
          return { interpreter };
        }),
      );

      expect(interpreter.codeInterpreterId).toBeTruthy();
      expect(interpreter.codeInterpreterArn).toContain(":code-interpreter");
      expect(interpreter.status).toBe("READY");

      // out-of-band verification via distilled
      const observed = yield* control.getCodeInterpreter({
        codeInterpreterId: interpreter.codeInterpreterId,
      });
      expect(observed.status).toBe("READY");
      expect(observed.networkConfiguration.networkMode).toBe("SANDBOX");

      // network mode is create-only — changing it must replace
      const { interpreter: replaced } = yield* stack.deploy(
        Effect.gen(function* () {
          const interpreter = yield* CodeInterpreter("Sandbox", {
            networkConfiguration: { networkMode: "PUBLIC" },
            tags: { fixture: "agentcore-code-interpreter" },
          });
          return { interpreter };
        }),
      );
      expect(replaced.codeInterpreterId).not.toBe(
        interpreter.codeInterpreterId,
      );
      const observedReplaced = yield* control.getCodeInterpreter({
        codeInterpreterId: replaced.codeInterpreterId,
      });
      expect(observedReplaced.networkConfiguration.networkMode).toBe("PUBLIC");

      yield* stack.destroy();
      yield* assertInterpreterGone(replaced.codeInterpreterId);
    }),
  { timeout: 180_000 },
);
