import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as ProcessRunner from "../processRunner.ts";

const Subject = Schema.fromJsonString(
  Schema.Struct({
    title: Schema.String,
    body: Schema.NullOr(Schema.String),
  }),
);
const decodeSubject = Schema.decodeUnknownEffect(Subject);
const encodeSubject = Schema.encodeEffect(Subject);

/** Read only explicit GitHub references. The issues endpoint also returns PR subjects. */
export const resolveThreadTitleLinks = Effect.fn("resolveThreadTitleLinks")(function* (input: {
  message: string;
  cwd: string;
}) {
  const runner = yield* ProcessRunner.ProcessRunner;
  const references = Array.from(
    input.message.matchAll(
      /https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(?:pull|issues)\/([1-9]\d*)(?=$|[\s/#?)>.,])/g,
    ),
  );
  const unique = [...new Map(references.map((match) => [match[0], match])).values()].slice(0, 2);
  const subjects = yield* Effect.forEach(
    unique,
    (match) =>
      Effect.gen(function* () {
        const result = yield* runner.run({
          command: "gh",
          args: [
            "api",
            `repos/${match[1]}/${match[2]}/issues/${match[3]}`,
            "--jq",
            "{title, body}",
          ],
          cwd: input.cwd,
          timeout: "3 seconds",
          maxOutputBytes: 32_000,
          env: { ...process.env, GH_PROMPT_DISABLED: "1" },
        });
        if (result.code !== 0) return `${match[0]}: unavailable`;
        const subject = yield* decodeSubject(result.stdout);
        const summary = yield* encodeSubject({
          title: subject.title.slice(0, 300),
          body: subject.body?.slice(0, 1_200) ?? "",
        });
        return `${match[0]}\n${summary}`;
      }).pipe(
        Effect.timeout("3 seconds"),
        Effect.catch(() => Effect.succeed(`${match[0]}: unavailable`)),
      ),
    { concurrency: 2 },
  );
  return subjects.length > 0 ? subjects.join("\n\n") : undefined;
});
