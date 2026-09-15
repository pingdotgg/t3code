import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";

const encodeSubject = Schema.encodeEffect(
  Schema.fromJsonString(Schema.Struct({ title: Schema.String, body: Schema.String })),
);

/** Providers select supported links before the title lookup budget is applied. */
export const resolveThreadTitleLinks = Effect.fn("resolveThreadTitleLinks")(function* (input: {
  message: string;
  cwd: string;
}) {
  const providers = yield* SourceControlProviderRegistry.SourceControlProviderRegistry;
  const links = new Map<string, NonNullable<ReturnType<typeof providers.resolveLink>>>();
  for (const match of input.message.matchAll(/https:\/\/[^\s<>"')]+/g)) {
    let url: URL;
    try {
      url = new URL(match[0].replace(/[.,;!?]+$/, ""));
    } catch {
      continue;
    }
    url.hash = "";
    url.search = "";
    if (links.has(url.href)) continue;
    const lookup = providers.resolveLink({ cwd: input.cwd, url });
    if (!lookup) continue;
    links.set(url.href, lookup);
    if (links.size === 2) break;
  }
  const subjects = yield* Effect.forEach(
    links,
    ([url, lookup]) =>
      lookup.pipe(
        Effect.flatMap((subject) =>
          encodeSubject({
            title: subject.title.slice(0, 300),
            body: subject.body?.slice(0, 1_200) ?? "",
          }),
        ),
        Effect.map((summary) => `${url}\n${summary}`),
        Effect.timeout("3 seconds"),
        Effect.catch(() => Effect.succeed(`${url}: unavailable`)),
      ),
    { concurrency: 2 },
  );
  return subjects.length > 0 ? subjects.join("\n\n") : undefined;
});
