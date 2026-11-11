import * as Alchemy from "alchemy";
import { Interaction } from "alchemy/Interaction";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export default Alchemy.Stack(
  "CliPackageCanary",
  { providers: Layer.empty, state: Alchemy.localState() },
  Effect.gen(function* () {
    const interaction = yield* Interaction;
    yield* interaction.task({ label: "Packed CLI progress" }, Effect.void);
    yield* Effect.sync(() => {
      process.stdout.write(
        `CLI_PACKAGE_PROBE=${JSON.stringify({
          runtime: process.versions.bun ? "bun" : "node",
          nodeEnv: process.env.NODE_ENV,
          home: process.env.HOME,
          credentialVariables: Object.keys(process.env).filter((name) =>
            /TOKEN|SECRET|PASSWORD|CREDENTIAL|API_KEY|ACCESS_KEY|AWS_PROFILE/i.test(name),
          ),
          cwd: process.cwd(),
          entry: process.argv[1],
          alchemy: import.meta.resolve("alchemy"),
          args: process.argv.slice(2),
        })}\n`,
      );
    });
    return { message: "Packed CLI deployment complete" };
  }),
);
