import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { Command } from "effect/unstable/cli";
import { HttpClient, HttpClientError, HttpClientResponse, UrlParams } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  buildDiscordReleaseAnnouncement,
  notifyDiscordReleaseCommand,
  postDiscordWebhook,
} from "./notify-discord-release.ts";

const latestAnnouncement = {
  target: "latest",
  roleId: "222222222222222222",
  releaseName: "T3 Code v1.2.3",
  version: "1.2.3",
  tag: "v1.2.3",
  releaseUrl: new URL("https://github.com/pingdotgg/t3code/releases/tag/v1.2.3"),
  timestamp: "2026-05-01T01:41:00.000Z",
} as const;
const nightlyAnnouncement = { ...latestAnnouncement, target: "prerelease" } as const;
// Deliberately fake. All HTTP requests below use an injected client.
const webhookUrl = new URL("https://discord.com/api/webhooks/123456/test-secret-token");
const intro = "A new T3 Code prerelease is available for nightly testers.";
const notes = `## What's Changed\n* Fix remote reconnection by @contributor in https://github.com/pingdotgg/t3code/pull/10\n* Improve thread search in https://github.com/pingdotgg/t3code/pull/11\n\n**Full Changelog**: https://github.com/pingdotgg/t3code/compare/v1.2.2...v1.2.3`;
const formattedNotes = `## What's Changed\n* [Fix remote reconnection](https://github.com/pingdotgg/t3code/pull/10) by [@contributor](https://github.com/contributor)\n* [Improve thread search](https://github.com/pingdotgg/t3code/pull/11)\n\n[Full Changelog](https://github.com/pingdotgg/t3code/compare/v1.2.2...v1.2.3)`;
const runCli = Command.runWith(notifyDiscordReleaseCommand, { version: "0.0.0" });
const cliArgs = (target: "latest" | "prerelease") => [
  target,
  "--role-id",
  latestAnnouncement.roleId,
  "--release-name",
  latestAnnouncement.releaseName,
  "--release-version",
  latestAnnouncement.version,
  "--tag",
  latestAnnouncement.tag,
  "--release-url",
  latestAnnouncement.releaseUrl.href,
];
const configLayer = ConfigProvider.layer(
  ConfigProvider.fromEnv({ env: { DISCORD_WEBHOOK_URL: webhookUrl.href } }),
);
const PayloadSchema = Schema.fromJsonString(
  Schema.Struct({
    content: Schema.String,
    allowed_mentions: Schema.Struct({
      parse: Schema.Array(Schema.String),
      roles: Schema.Array(Schema.String),
    }),
    embeds: Schema.Array(
      Schema.Struct({ title: Schema.String, description: Schema.String, url: Schema.String }),
    ),
  }),
);
const decodePayload = Schema.decodeUnknownSync(PayloadSchema);
const payloadDescription = (payloads: ReturnType<typeof buildDiscordReleaseAnnouncement>) =>
  payloads.flatMap((payload) => payload.embeds.map((embed) => embed.description)).join("");
const captureClient = (requests: string[], status = 204) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      assert.deepStrictEqual(UrlParams.getAll(request.urlParams, "wait"), ["true"]);
      assert.equal(request.body._tag, "Uint8Array");
      if (request.body._tag !== "Uint8Array") return Effect.die("Expected JSON request body");
      requests.push(new TextDecoder().decode(request.body.body));
      return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status })));
    }),
  );

function assertDiscordLimits(payloads: ReturnType<typeof buildDiscordReleaseAnnouncement>) {
  for (const payload of payloads) {
    assert.ok(payload.content.length <= 2000);
    assert.equal(payload.embeds.length, 1);
    let total = 0;
    for (const embed of payload.embeds) {
      assert.ok(embed.title.length <= 256);
      assert.ok(embed.description.length <= 4096);
      assert.ok(embed.footer.text.length <= 2048);
      total += embed.title.length + embed.description.length + embed.footer.text.length;
    }
    assert.ok(total <= 6000);
  }
}

it("includes nightly changes in order with their links and existing metadata", () => {
  const payloads = buildDiscordReleaseAnnouncement({ ...nightlyAnnouncement, releaseNotes: notes });
  assert.deepStrictEqual(payloads, [
    {
      content: "-# <@&222222222222222222>",
      allowed_mentions: { parse: [], roles: [latestAnnouncement.roleId] },
      embeds: [
        {
          title: latestAnnouncement.releaseName,
          url: latestAnnouncement.releaseUrl.href,
          description: `${intro}\n\n${formattedNotes}`,
          color: 0x5865f2,
          footer: { text: "v1.2.3" },
          timestamp: latestAnnouncement.timestamp,
        },
      ],
    },
  ]);
  assertDiscordLimits(payloads);
});

it("keeps stable announcements short even when a long changelog is provided", () => {
  assert.deepStrictEqual(
    buildDiscordReleaseAnnouncement({ ...latestAnnouncement, releaseNotes: notes.repeat(200) }),
    [
      {
        content: "-# <@&222222222222222222>",
        allowed_mentions: { parse: [], roles: [latestAnnouncement.roleId] },
        embeds: [
          {
            title: latestAnnouncement.releaseName,
            url: latestAnnouncement.releaseUrl.href,
            description: `[View full release notes on GitHub](${latestAnnouncement.releaseUrl.href})`,
            color: 0x2ecc71,
            footer: { text: "v1.2.3" },
            timestamp: latestAnnouncement.timestamp,
          },
        ],
      },
    ],
  );
});

it("links contributor profiles and escapes brackets in change titles and bot handles", () => {
  const releaseNotes =
    "* Fix [web] links by @octo-user in https://github.com/pingdotgg/t3code/pull/12\n* Bump dependencies by @dependabot[bot] in https://github.com/pingdotgg/t3code/pull/13";
  const payloads = buildDiscordReleaseAnnouncement({ ...nightlyAnnouncement, releaseNotes });
  assert.equal(
    payloadDescription(payloads),
    `${intro}\n\n* [Fix \\[web\\] links](https://github.com/pingdotgg/t3code/pull/12) by [@octo-user](https://github.com/octo-user)\n* [Bump dependencies](https://github.com/pingdotgg/t3code/pull/13) by [@dependabot\\[bot\\]](https://github.com/apps/dependabot)`,
  );
});

it("preserves custom notes and links outside generated GitHub pull request entries", () => {
  const releaseNotes =
    "## Migration\n* Written by @someone in the docs\n* Commit https://github.com/pingdotgg/t3code/commit/abc123\n[Guide](https://example.com/guide)";
  assert.equal(
    payloadDescription(buildDiscordReleaseAnnouncement({ ...nightlyAnnouncement, releaseNotes })),
    `${intro}\n\n${releaseNotes}`,
  );
});

it("links the Full Changelog label instead of displaying the comparison URL", () => {
  const url = "https://github.com/pingdotgg/t3code/compare/previous...next";
  const releaseNotes = `**Full Changelog**: ${url}\nFull Changelog: ${url}`;
  const description = payloadDescription(
    buildDiscordReleaseAnnouncement({ ...nightlyAnnouncement, releaseNotes }),
  );
  assert.equal(description, `${intro}\n\n[Full Changelog](${url})\n[Full Changelog](${url})`);
});

it("keeps inline change attribution whole at a message boundary", () => {
  const title = "* [Fix reconnection](https://github.com/pingdotgg/t3code/pull/10)";
  const contributor = "[@contributor](https://github.com/contributor)";
  const filler = "x".repeat(4096 - intro.length - 2 - title.length - 2);
  const releaseNotes = `${filler}\n* Fix reconnection by @contributor in https://github.com/pingdotgg/t3code/pull/10`;
  const payloads = buildDiscordReleaseAnnouncement({ ...nightlyAnnouncement, releaseNotes });
  assert.equal(payloads.length, 2);
  assert.equal(payloads[1]?.embeds[0]?.description, `${title} by ${contributor}`);
  assert.equal(payloadDescription(payloads), `${intro}\n\n${filler}\n${title} by ${contributor}`);
  assertDiscordLimits(payloads);
});

it("falls back when notes are missing, empty, or whitespace", () => {
  const fallback = buildDiscordReleaseAnnouncement(nightlyAnnouncement);
  assert.equal(payloadDescription(fallback), intro);
  assert.deepStrictEqual(
    buildDiscordReleaseAnnouncement({ ...nightlyAnnouncement, releaseNotes: "" }),
    fallback,
  );
  assert.deepStrictEqual(
    buildDiscordReleaseAnnouncement({ ...nightlyAnnouncement, releaseNotes: " \r\n\t" }),
    fallback,
  );
});

it("splits long notes at line boundaries without dropping changes or the comparison link", () => {
  const longNotes =
    Array.from(
      { length: 150 },
      (_, i) => `* Change ${i} in https://github.com/pingdotgg/t3code/pull/${i}\n`,
    ).join("") + notes;
  const payloads = buildDiscordReleaseAnnouncement({
    ...nightlyAnnouncement,
    releaseNotes: longNotes,
  });
  assert.ok(payloads.length > 2);
  const formattedChanges = Array.from(
    { length: 150 },
    (_, i) => `* [Change ${i}](https://github.com/pingdotgg/t3code/pull/${i})\n`,
  ).join("");
  assert.equal(payloadDescription(payloads), `${intro}\n\n${formattedChanges}${formattedNotes}`);
  assertDiscordLimits(payloads);
  for (const [index, payload] of payloads.entries()) {
    assert.deepStrictEqual(payload.allowed_mentions, {
      parse: [],
      roles: index === 0 ? [latestAnnouncement.roleId] : [],
    });
    if (index > 0) {
      assert.equal(payload.content, "");
      assert.equal(
        payload.embeds[0]?.title,
        `Changelog continued (${index + 1}/${payloads.length})`,
      );
    }
    if (index < payloads.length - 1) assert.ok(payload.embeds[0]?.description.endsWith("\n"));
    assert.equal(payload.embeds[0]?.url, nightlyAnnouncement.releaseUrl.href);
  }
});

it("honors the aggregate embed limit when metadata is also large", () => {
  const releaseNotes = "a".repeat(16000);
  const payloads = buildDiscordReleaseAnnouncement({
    ...nightlyAnnouncement,
    releaseName: "n".repeat(256),
    version: "x".repeat(2047),
    releaseNotes,
  });
  assertDiscordLimits(payloads);
  assert.equal(payloadDescription(payloads), `${intro}\n\n${releaseNotes}`);
});

it("handles oversized lines, words, and Unicode without losing or breaking characters", () => {
  const longNotes =
    "a".repeat(9000) + "\n" + "🦋".repeat(4500) + "\n" + "word ".repeat(2000).trim();
  const payloads = buildDiscordReleaseAnnouncement({
    ...nightlyAnnouncement,
    releaseNotes: longNotes,
  });
  assertDiscordLimits(payloads);
  assert.equal(payloadDescription(payloads), `${intro}\n\n${longNotes}`);
  for (const payload of payloads) assert.ok(payload.embeds[0]?.description.isWellFormed());
});

it("accepts exactly 4096 description characters and splits the next character", () => {
  const releaseNotes = "x".repeat(4096 - intro.length - 2);
  assert.equal(buildDiscordReleaseAnnouncement({ ...nightlyAnnouncement, releaseNotes }).length, 1);
  const longer = buildDiscordReleaseAnnouncement({
    ...nightlyAnnouncement,
    releaseNotes: releaseNotes + "x",
  });
  assert.equal(longer.length, 2);
  assert.equal(payloadDescription(longer), `${intro}\n\n${releaseNotes}x`);
  assertDiscordLimits(longer);
});

it("suppresses everyone, here, user, and role mentions on every message", () => {
  const mentions = `@everyone @here <@123> <@!123> <@&456> <@&${nightlyAnnouncement.roleId}>`;
  const inert = mentions.replaceAll("@", "@\u200b");
  const payloads = buildDiscordReleaseAnnouncement({
    ...nightlyAnnouncement,
    releaseName: mentions,
    releaseNotes: `${mentions}\n`.repeat(100) + notes,
  });
  assert.ok(payloads.length > 1);
  assert.equal(
    payloadDescription(payloads),
    `${intro}\n\n${`${inert}\n`.repeat(100)}${formattedNotes}`,
  );
  for (const [index, payload] of payloads.entries()) {
    assert.deepStrictEqual(payload.allowed_mentions, {
      parse: [],
      roles: index === 0 ? [latestAnnouncement.roleId] : [],
    });
    if (index === 0) assert.equal(payload.embeds[0]?.title, inert);
    assert.ok(!payload.content.includes("@everyone"));
    assert.ok(!payload.content.includes("@here"));
    assert.equal(payload.content.match(/<@&\d+>/g)?.length ?? 0, index === 0 ? 1 : 0);
  }
});

it("rejects invalid metadata before sending", () => {
  assert.throws(
    () => buildDiscordReleaseAnnouncement({ ...nightlyAnnouncement, releaseName: "x".repeat(257) }),
    /title exceeds/,
  );
  assert.throws(
    () => buildDiscordReleaseAnnouncement({ ...nightlyAnnouncement, version: "x".repeat(2048) }),
    /footer exceeds/,
  );
  assert.throws(
    () => buildDiscordReleaseAnnouncement({ ...nightlyAnnouncement, roleId: "123> @everyone" }),
    /Invalid Discord release role/,
  );
});

it.effect("retains safe request context without leaking the webhook URL or nested cause", () =>
  Effect.gen(function* () {
    const payload = buildDiscordReleaseAnnouncement(latestAnnouncement)[0]!;
    const logs: string[] = [];
    const client = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.EncodeError({
              request,
              cause: new Error(`Encoder failed for ${webhookUrl.href}`),
            }),
          }),
        ),
      ),
    );
    const error = yield* postDiscordWebhook(webhookUrl, payload, latestAnnouncement).pipe(
      Effect.tapCause(Effect.logError),
      Effect.provide([
        client,
        Logger.layer([
          Logger.make((options) => {
            logs.push(Logger.formatJson.log(options));
          }),
        ]),
      ]),
      Effect.flip,
    );
    if (error._tag !== "DiscordReleaseWebhookRequestError")
      assert.fail(`Unexpected error: ${error._tag}`);
    assert.equal(error.reason, "EncodeError");
    assert.equal(error.target, "latest");
    assert.equal(error.tag, latestAnnouncement.tag);
    assert.equal(error.webhookOrigin, webhookUrl.origin);
    assert.equal(error.webhookPathnameSegmentCount, 4);
    assert.equal(error.contentLength, payload.content.length);
    assert.equal(error.allowedRoleMentionCount, 1);
    assert.ok(!Cause.pretty(Cause.fail(error)).includes("test-secret-token"));
    assert.ok(!logs.join("\n").includes("test-secret-token"));
  }),
);

it.effect(
  "retains response status without retaining the secret-bearing request or response body",
  () =>
    Effect.gen(function* () {
      const client = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(request, new Response(webhookUrl.href, { status: 400 })),
          ),
        ),
      );
      const error = yield* postDiscordWebhook(
        webhookUrl,
        buildDiscordReleaseAnnouncement(latestAnnouncement)[0]!,
        latestAnnouncement,
      ).pipe(Effect.provide(client), Effect.flip);
      if (error._tag !== "DiscordReleaseWebhookResponseError")
        assert.fail(`Unexpected error: ${error._tag}`);
      assert.equal(error.status, 400);
      assert.equal(error.tag, latestAnnouncement.tag);
      assert.ok(!Cause.pretty(Cause.fail(error)).includes("test-secret-token"));
    }),
);

it.effect("waits for Retry-After before retrying a rate-limited message", () =>
  Effect.gen(function* () {
    const limited = yield* Deferred.make<void>();
    let attempts = 0;
    const client = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.gen(function* () {
          attempts += 1;
          if (attempts === 1) {
            yield* Deferred.succeed(limited, undefined);
            return HttpClientResponse.fromWeb(
              request,
              new Response(null, { status: 429, headers: { "retry-after": "2" } }),
            );
          }
          return HttpClientResponse.fromWeb(request, new Response(null, { status: 204 }));
        }),
      ),
    );
    const fiber = yield* postDiscordWebhook(
      webhookUrl,
      buildDiscordReleaseAnnouncement(latestAnnouncement)[0]!,
      latestAnnouncement,
    ).pipe(Effect.provide(client), Effect.forkChild);
    yield* Deferred.await(limited);
    yield* TestClock.adjust("1 second");
    assert.equal(attempts, 1);
    yield* TestClock.adjust("1 second");
    yield* Fiber.join(fiber);
    assert.equal(attempts, 2);
  }),
);

it.effect("bounds total retry time while preserving delays within the deadline", () =>
  Effect.gen(function* () {
    const limited = yield* Deferred.make<void>();
    let attempts = 0;
    const client = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.gen(function* () {
          attempts += 1;
          yield* Deferred.succeed(limited, undefined);
          return HttpClientResponse.fromWeb(
            request,
            new Response(null, { status: 429, headers: { "retry-after": "40" } }),
          );
        }),
      ),
    );
    const fiber = yield* postDiscordWebhook(
      webhookUrl,
      buildDiscordReleaseAnnouncement(latestAnnouncement)[0]!,
      latestAnnouncement,
    ).pipe(Effect.provide(client), Effect.result, Effect.forkChild);
    yield* Deferred.await(limited);
    yield* TestClock.adjust("39 seconds");
    assert.equal(attempts, 1);
    yield* TestClock.adjust("1 second");
    assert.equal(attempts, 2);
    yield* TestClock.adjust("20 seconds");
    const result = yield* Fiber.join(fiber);
    assert.equal(attempts, 2);
    assert.equal(result._tag, "Failure");
    if (result._tag !== "Failure") assert.fail("Expected the retry deadline to expire");
    assert.equal(result.failure._tag, "DiscordReleaseWebhookRequestError");
    if (result.failure._tag !== "DiscordReleaseWebhookRequestError")
      assert.fail(`Unexpected error: ${result.failure._tag}`);
    assert.equal(result.failure.reason, "TimeoutError");
    assert.ok(!Cause.pretty(Cause.fail(result.failure)).includes("test-secret-token"));
  }),
);

// Run the checked-in shell commands with gh/node stubs, then send their captured
// arguments through the real CLI parser and an injected HTTP client.
function workflowRun(workflow: string, stepName: string) {
  const step = workflow.split(`      - name: ${stepName}\n`)[1]?.split("\n      - name:")[0];
  assert.ok(step, `Missing workflow step: ${stepName}`);
  const run = step.split("        run: |\n")[1];
  assert.ok(run, `Missing run block: ${stepName}`);
  return run
    .split("\n")
    .map((line) => line.replace(/^          /, ""))
    .join("\n");
}

it.layer(NodeServices.layer)("Discord release CLI and workflow", (it) => {
  it.effect("passes the published nightly body from the workflow to ordered sends", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const temp = yield* fs.makeTempDirectoryScoped({ prefix: "discord release " });
      const workflow = yield* fs.readFileString(
        yield* path.fromFileUrl(new URL("../.github/workflows/release.yml", import.meta.url)),
      );
      const publishedNotes =
        Array.from({ length: 50 }, () => notes).join("\n\n") +
        '\n* Literal $(touch "$RUNNER_TEMP/executed") and `touch "$RUNNER_TEMP/executed"`';
      const read = workflowRun(workflow, "Read published release notes");
      const shellEnv = {
        RUNNER_TEMP: temp,
        RELEASE_TAG: nightlyAnnouncement.tag,
        RELEASE_CHANNEL: "nightly",
        FIXTURE_NOTES: publishedNotes,
      };
      const readStatus = yield* spawner.exitCode(
        ChildProcess.make(
          "bash",
          [
            "-e",
            "-c",
            `gh() { [ "$*" = 'release view v1.2.3 --json body --jq .body // ""' ] || return 1; printf '%s' "$FIXTURE_NOTES"; }\n${read}`,
          ],
          { env: shellEnv },
        ),
      );
      assert.equal(readStatus, 0);
      assert.equal(yield* fs.readFileString(`${temp}/discord-release-notes.md`), publishedNotes);
      const replacements: Record<string, string> = {
        "needs.preflight.outputs.release_name": latestAnnouncement.releaseName,
        "needs.preflight.outputs.version": latestAnnouncement.version,
        "needs.preflight.outputs.tag": latestAnnouncement.tag,
        "github.repository": "pingdotgg/t3code",
      };
      const announce = workflowRun(workflow, "Announce prerelease on Discord").replace(
        /\$\{\{ (.*?) \}\}/g,
        (_, key: string) => {
          assert.ok(replacements[key], `Unexpected expression: ${key}`);
          return replacements[key]!;
        },
      );
      const announceStatus = yield* spawner.exitCode(
        ChildProcess.make(
          "bash",
          ["-e", "-c", `node() { printf '%s\\0' "$@" > "$RUNNER_TEMP/args"; }\n${announce}`],
          { env: { RUNNER_TEMP: temp, DISCORD_MENTION_ROLE_ID: latestAnnouncement.roleId } },
        ),
      );
      assert.equal(announceStatus, 0);
      const args = (yield* fs.readFileString(`${temp}/args`)).split("\0").slice(1, -1);
      const requests: string[] = [];
      yield* runCli(args).pipe(Effect.provide([configLayer, captureClient(requests)]));
      const payloads = requests.map((request) => decodePayload(request));
      assert.ok(payloads.length > 2);
      assert.equal(
        payloads.flatMap((payload) => payload.embeds.map((embed) => embed.description)).join(""),
        `${intro}\n\n${Array.from({ length: 50 }, () => formattedNotes).join("\n\n")}\n* Literal $(touch "$RUNNER_TEMP/executed") and \`touch "$RUNNER_TEMP/executed"\``,
      );
      for (const [index, payload] of payloads.entries())
        assert.deepStrictEqual(payload.allowed_mentions, {
          parse: [],
          roles: index === 0 ? [latestAnnouncement.roleId] : [],
        });
      assert.equal(yield* fs.exists(`${temp}/executed`), false);
      assert.equal(
        yield* spawner.exitCode(
          ChildProcess.make("bash", ["-e", "-c", `gh() { return 99; }\n${read}`], {
            env: { ...shellEnv, RELEASE_CHANNEL: "stable" },
          }),
        ),
        0,
      );
      assert.equal(yield* fs.readFileString(`${temp}/discord-release-notes.md`), "");
      assert.equal(
        yield* spawner.exitCode(
          ChildProcess.make(
            "bash",
            ["-e", "-c", `gh() { printf '%s' 'partial changelog'; return 42; }\n${read}`],
            { env: shellEnv },
          ),
        ),
        0,
      );
      assert.equal(yield* fs.readFileString(`${temp}/discord-release-notes.md`), "");
      const fallbackRequests: string[] = [];
      yield* runCli(args).pipe(Effect.provide([configLayer, captureClient(fallbackRequests)]));
      assert.equal(fallbackRequests.length, 1);
      const fallback = decodePayload(fallbackRequests[0]!);
      assert.equal(fallback.embeds[0]?.description, intro);
      assert.equal(fallback.content, `-# <@&${latestAnnouncement.roleId}>`);
      assert.deepStrictEqual(fallback.allowed_mentions, {
        parse: [],
        roles: [latestAnnouncement.roleId],
      });
      assert.ok(
        workflow
          .split("      - name: Announce prerelease on Discord\n")[1]
          ?.startsWith("        if: needs.preflight.outputs.is_prerelease == 'true'\n"),
      );
      assert.ok(workflow.includes("GH_REPO: ${{ github.repository }}"));
      assert.ok(workflow.includes("RELEASE_TAG: ${{ needs.preflight.outputs.tag }}"));
      assert.ok(
        !workflowRun(workflow, "Announce latest release on Discord").includes(
          "--release-notes-file",
        ),
      );
      assert.ok(
        workflow
          .slice(workflow.indexOf("  announce_discord:"))
          .includes("needs.preflight.outputs.release_channel != 'preview'"),
      );
    }),
  );

  it.effect("uses the fallback when notes are omitted and ignores a notes file for latest", () =>
    Effect.gen(function* () {
      const requests: string[] = [];
      yield* runCli(cliArgs("prerelease")).pipe(
        Effect.provide([configLayer, captureClient(requests)]),
      );
      assert.equal(decodePayload(requests[0]!).embeds[0]?.description, intro);
      yield* runCli([
        ...cliArgs("latest"),
        "--release-notes-file",
        "/missing-stable-notes.md",
      ]).pipe(Effect.provide([configLayer, captureClient(requests)]));
      assert.equal(requests.length, 2);
      assert.equal(
        decodePayload(requests[1]!).embeds[0]?.description,
        `[View full release notes on GitHub](${latestAnnouncement.releaseUrl.href})`,
      );
    }),
  );

  it.effect("fails before sending when the requested nightly notes file cannot be read", () =>
    Effect.gen(function* () {
      const requests: string[] = [];
      const result = yield* runCli([
        ...cliArgs("prerelease"),
        "--release-notes-file",
        "/missing-nightly-notes.md",
      ]).pipe(Effect.provide([configLayer, captureClient(requests)]), Effect.result);
      assert.equal(result._tag, "Failure");
      assert.deepStrictEqual(requests, []);
    }),
  );

  it.effect("stops on a failed send rather than posting later continuations", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const temp = yield* fs.makeTempDirectoryScoped();
      const file = `${temp}/notes.md`;
      yield* fs.writeFileString(file, notes.repeat(100));
      const requests: string[] = [];
      const result = yield* runCli([...cliArgs("prerelease"), "--release-notes-file", file]).pipe(
        Effect.provide([configLayer, captureClient(requests, 400)]),
        Effect.result,
      );
      assert.equal(result._tag, "Failure");
      assert.equal(requests.length, 1);
    }),
  );

  it.effect("does not expose an invalid webhook secret in configuration errors", () =>
    Effect.gen(function* () {
      const requests: string[] = [];
      const result = yield* runCli(cliArgs("latest")).pipe(
        Effect.provide([
          ConfigProvider.layer(
            ConfigProvider.fromEnv({ env: { DISCORD_WEBHOOK_URL: "invalid-test-secret-token" } }),
          ),
          captureClient(requests),
        ]),
        Effect.result,
      );
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure")
        assert.ok(!Cause.pretty(Cause.fail(result.failure)).includes("test-secret-token"));
      assert.deepStrictEqual(requests, []);
    }),
  );
});
