import * as Effect from "effect/Effect";
import * as S from "effect/Schema";

import * as AI from "alchemy/AI";

export const cmd = AI.Parameter("cmd")(
  S.String.pipe(S.optional),
)`The command to run.`;

export const Bash = AI.Tool("bash")`
Run a shell ${cmd} and return its stdout, stderr, and exit code.`(
  Effect.fn(function* ({ cmd }) {
    void cmd;
  }),
);
