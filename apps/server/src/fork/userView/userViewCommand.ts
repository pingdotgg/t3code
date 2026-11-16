import { THREAD_USER_VIEW_TOOL_NAME, ThreadUserViewResult } from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Command, Flag } from "effect/cli";

import { projectLocationFlags } from "../../cli/config.ts";
import type {
  decodeThreadId,
  reportThreadErrors,
  threadArgument,
  withThreadTools,
} from "../../cli/thread.ts";

const given = (flags: Readonly<Record<string, Option.Option<unknown>>>) =>
  Object.fromEntries(
    Object.entries(flags).flatMap(([key, value]) =>
      Option.isSome(value) ? [[key, value.value]] : [],
    ),
  );

/** cli/thread.ts passes its helpers in, so this module never imports it at run time. */
export function userViewCommand(cli: {
  readonly decodeThreadId: typeof decodeThreadId;
  readonly reportThreadErrors: typeof reportThreadErrors;
  readonly threadArgument: typeof threadArgument;
  readonly withThreadTools: typeof withThreadTools;
}) {
  const { decodeThreadId, reportThreadErrors, threadArgument, withThreadTools } = cli;
  return Command.make("user-view", {
    ...projectLocationFlags,
    thread: threadArgument,
    subThread: Flag.String("sub-thread").pipe(
      Flag.withDescription(
        "A sub-thread, by the id of its first message, of a reply in it, or of the message its first message answers.",
      ),
      Flag.optional,
    ),
    main: Flag.Int("main").pipe(
      Flag.withDescription(
        "How many main-list messages: the latest (default 20), or with --sub-thread, those before it (default 3).",
      ),
      Flag.optional,
    ),
    through: Flag.String("through").pipe(
      Flag.withDescription("The id of the last message to show."),
      Flag.optional,
    ),
    expect: Flag.String("expect").pipe(
      Flag.withDescription("The sha256 of a pinned view; a changed view says so first."),
      Flag.optional,
    ),
  }).pipe(
    Command.withDescription(
      "Print part of a thread word for word as the user's screen shows it in Chat mode.",
    ),
    Command.withHandler((flags) =>
      Effect.gen(function* () {
        const threadId = yield* decodeThreadId(flags.thread);
        yield* withThreadTools(
          flags,
          Effect.fn("cli.thread.userView")(function* (tools) {
            const { text } = yield* tools.call(
              THREAD_USER_VIEW_TOOL_NAME,
              {
                threadId,
                ...given({
                  subThread: flags.subThread,
                  main: flags.main,
                  through: flags.through,
                  expect: flags.expect,
                }),
              },
              ThreadUserViewResult,
            );
            yield* Console.log(text);
          }),
        );
      }).pipe(reportThreadErrors),
    ),
  );
}
