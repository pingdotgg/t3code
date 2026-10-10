import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { SourceControlProviderAuth, VcsProcessSpawnError } from "@t3tools/contracts";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";

import * as ForgejoCli from "./ForgejoCli.ts";
import * as ForgejoSourceControlProvider from "./ForgejoSourceControlProvider.ts";

const output = TestSourceControlHost.processOutput;
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const encodeAuth = Schema.encodeEffect(SourceControlProviderAuth);
const decodeAuth = Schema.decodeEffect(SourceControlProviderAuth);

const accountFailures = [
  {
    reason: "forbidden",
    httpStatus: 403,
    expectedDetail: "Account verification failed (HTTP 403). Check this account's permissions.",
  },
  {
    reason: "rate-limit",
    httpStatus: 429,
    expectedDetail:
      "Account verification failed (HTTP 429). Rescan after the server's rate limit resets.",
  },
] satisfies ReadonlyArray<{
  reason: NonNullable<ForgejoCli.ForgejoCliError["reason"]>;
  httpStatus: number;
  expectedDetail: string;
}>;

it.effect.each(accountFailures)(
  "preserves $reason diagnostics for the selected fj account",
  (failure) =>
    Effect.gen(function* () {
      const spec = yield* ForgejoSourceControlProvider.makeDiscovery;
      if (spec.type !== "managed-cli") return yield* Effect.die("Expected managed discovery");
      const result = yield* spec.probe("/repo");
      assert.strictEqual(result.executable, "fj");
      assert.strictEqual(result.auth.status, "unknown");
      assert.deepStrictEqual(result.auth.detail, Option.some(failure.expectedDetail));
      assert.strictEqual(result.auth.instances?.[0]?.detail, failure.expectedDetail);
      const encoded = yield* encodeAuth(result.auth);
      assert.deepStrictEqual(yield* decodeAuth(encoded), result.auth);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(ForgejoCli.ForgejoCli)({
            listLogins: ({ command }) =>
              Effect.succeed(
                command === "fj"
                  ? [{ name: "work", url: "https://work.test", user: "", default: "true" }]
                  : [],
              ),
            getAccount: ({ cwd }) =>
              Effect.fail(
                new ForgejoCli.ForgejoCliError({
                  command: "fj",
                  cwd,
                  reason: failure.reason,
                  httpStatus: failure.httpStatus,
                  detail: `Forgejo API request failed (HTTP ${failure.httpStatus}): <html>${"private response body".repeat(100_000)}</html>`,
                }),
              ),
          }),
          TestSourceControlHost.layer({
            process: { run: () => Effect.succeed(output("version")) },
          }),
        ),
      ),
    ),
);

it.effect("reports incomplete tea enumeration while retaining authenticated fj instances", () =>
  Effect.gen(function* () {
    const spec = yield* ForgejoSourceControlProvider.makeDiscovery;
    if (spec.type !== "managed-cli") return yield* Effect.die("Expected managed discovery");
    const result = yield* spec.probe("/repo");
    assert.strictEqual(result.auth.status, "authenticated");
    assert.strictEqual(result.auth.instances?.length, 1);
    assert.match(Option.getOrNull(result.auth.detail) ?? "", /Could not read tea connections/);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(ForgejoCli.ForgejoCli)({
          listLogins: ({ command, cwd }) =>
            command === "fj"
              ? Effect.succeed([
                  { name: "work", url: "https://work.test", user: "", default: "true" },
                ])
              : Effect.fail(
                  new ForgejoCli.ForgejoCliError({
                    command,
                    cwd,
                    detail: "Login storage is unreadable",
                  }),
                ),
          getAccount: () => Effect.succeed("alice"),
        }),
        TestSourceControlHost.layer({
          process: {
            run: (input) =>
              input.command === "tea" && input.args[0] === "login"
                ? Effect.fail(
                    new VcsProcessSpawnError({
                      operation: input.operation,
                      command: input.command,
                      cwd: input.cwd,
                      cause: new Error("status unavailable"),
                    }),
                  )
                : Effect.succeed(output("version")),
          },
        }),
      ),
    ),
  ),
);

it.effect("retains tea login identities when the status command fails", () =>
  Effect.gen(function* () {
    const spec = yield* ForgejoSourceControlProvider.makeDiscovery;
    if (spec.type !== "managed-cli") return yield* Effect.die("Expected managed discovery");
    const result = yield* spec.probe("/repo");
    assert.deepStrictEqual(
      result.auth.instances?.map((entry) => [entry.baseUrl, entry.status]),
      [
        ["https://one.test", "unknown"],
        ["https://two.test", "unknown"],
      ],
    );
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(ForgejoCli.ForgejoCli)({
          listLogins: ({ command }) =>
            Effect.succeed(
              command === "fj"
                ? []
                : [
                    { name: "one", url: "https://one.test", user: "alice", default: "true" },
                    { name: "two", url: "https://two.test", user: "bob", default: "false" },
                  ],
            ),
        }),
        TestSourceControlHost.layer({
          process: {
            run: (input) =>
              input.command === "tea" && input.args[0] === "login"
                ? Effect.fail(
                    new VcsProcessSpawnError({
                      operation: input.operation,
                      command: input.command,
                      cwd: input.cwd,
                      cause: new Error("status unavailable"),
                    }),
                  )
                : Effect.succeed(output("version")),
          },
        }),
      ),
    ),
  ),
);

it.effect(
  "isolates malformed tea identities without losing healthy connections or failing wire encoding",
  () =>
    Effect.gen(function* () {
      const auth = ForgejoSourceControlProvider.discovery.parseAuth(
        output(
          encodeJson([
            {
              name: "healthy",
              url: "https://one.test",
              user: "alice",
              default: "true",
              valid: "true",
            },
            { name: " ", url: "https://two.test", user: "bob", default: "false", valid: "true" },
            { name: "invalid-url", url: "", user: "bob", default: "false", valid: "false" },
            {
              name: "credential-url",
              url: "https://user:secret@two.test",
              user: "bob",
              default: "false",
              valid: "false",
            },
          ]),
        ),
      );
      assert.strictEqual(auth.instances?.length, 1);
      assert.isTrue(Option.isSome(auth.detail));
      const encoded = yield* encodeAuth(auth);
      assert.deepStrictEqual(yield* decodeAuth(encoded), auth);
    }),
);

it.effect("gives healthy fj accounts their own verification budget after a stalled account", () =>
  Effect.gen(function* () {
    const lock = yield* Semaphore.make(1);
    const started = yield* Deferred.make<void>();
    const spec = yield* ForgejoSourceControlProvider.makeDiscovery.pipe(
      Effect.provideService(
        ForgejoCli.ForgejoCli,
        ForgejoCli.ForgejoCli.of({
          execute: () => Effect.die("Unexpected execute"),
          resolveRepository: () => Effect.die("Unexpected repository lookup"),
          api: () => Effect.die("Unexpected API call"),
          listLogins: () =>
            Effect.succeed([
              { name: "offline", url: "https://offline.test", user: "", default: "true" },
              { name: "healthy", url: "https://healthy.test", user: "", default: "false" },
            ]),
          getAccount: ({ baseUrl }) =>
            lock.withPermits(1)(
              baseUrl === "https://offline.test"
                ? Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never))
                : Effect.sleep("1 second").pipe(Effect.as("alice")),
            ),
        }),
      ),
    );
    if (spec.type !== "managed-cli") return yield* Effect.die("Expected managed discovery");
    const fiber = yield* spec.probe("/repo").pipe(Effect.forkChild);
    yield* Deferred.await(started);
    yield* TestClock.adjust("5 seconds");
    yield* TestClock.adjust("1 second");
    const result = yield* Fiber.join(fiber);
    assert.deepStrictEqual(
      result.auth.instances
        ?.filter((entry) => entry.executable === "fj")
        .map((entry) => entry.status),
      ["unknown", "authenticated"],
    );
  }).pipe(
    Effect.provide(
      TestSourceControlHost.layer({ process: { run: () => Effect.succeed(output("version")) } }),
    ),
  ),
);

it.effect(
  "lists fj and tea instances with independent usernames, ports, mounts and failed accounts",
  () => {
    const fjLogins = [
      { name: "work", url: "https://forgejo.test", user: "", default: "false" },
      {
        name: "work",
        url: "https://forgejo.test",
        ssh_host: "ssh.forgejo.test",
        user: "",
        default: "false",
      },
      { name: "home", url: "https://forgejo.test:8443", user: "", default: "false" },
      { name: "revoked", url: "https://revoked.test", user: "", default: "false" },
      { name: "offline", url: "https://offline.test", user: "", default: "false" },
    ];
    const verified: string[] = [];
    return Effect.gen(function* () {
      const spec = yield* ForgejoSourceControlProvider.makeDiscovery;
      assert.strictEqual(spec.type, "managed-cli");
      if (spec.type !== "managed-cli") return;
      const result = yield* spec.probe("/repo");
      assert.strictEqual(result.executable, "fj");
      assert.deepStrictEqual(result.auth.account, Option.some("work-user"));
      assert.deepStrictEqual(result.auth.instances, [
        {
          baseUrl: "https://forgejo.test",
          executable: "fj",
          login: "work",
          account: Option.some("work-user"),
          status: "authenticated",
        },
        {
          baseUrl: "https://forgejo.test:8443",
          executable: "fj",
          login: "home",
          account: Option.some("home-user"),
          status: "authenticated",
        },
        {
          baseUrl: "https://revoked.test",
          executable: "fj",
          login: "revoked",
          account: Option.none(),
          status: "unauthenticated",
          detail: "Account verification failed. Authenticate this server again with fj.",
        },
        {
          baseUrl: "https://offline.test",
          executable: "fj",
          login: "offline",
          account: Option.none(),
          status: "unknown",
          detail: "Account verification failed. Check server availability and rescan.",
        },
        {
          baseUrl: "https://gitea.test/team",
          executable: "tea",
          login: "team",
          account: Option.some("team-user"),
          status: "authenticated",
        },
        {
          baseUrl: "https://forgejo.test",
          executable: "tea",
          login: "personal",
          account: Option.some("personal-user"),
          status: "unauthenticated",
        },
      ]);
      assert.strictEqual(verified.filter((url) => url === "https://forgejo.test").length, 1);
      const encoded = yield* encodeAuth(result.auth);
      assert.deepStrictEqual(yield* decodeAuth(encoded), result.auth);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(ForgejoCli.ForgejoCli)({
            listLogins: () => Effect.succeed(fjLogins),
            getAccount: ({ cwd, baseUrl }) => {
              verified.push(baseUrl);
              if (baseUrl === "https://revoked.test" || baseUrl === "https://offline.test") {
                return Effect.fail(
                  new ForgejoCli.ForgejoCliError({
                    command: "fj",
                    cwd,
                    detail: "Could not authenticate",
                    ...(baseUrl === "https://revoked.test" ? { reason: "authentication" } : {}),
                  }),
                );
              }
              return Effect.succeed(baseUrl.endsWith(":8443") ? "home-user" : "work-user");
            },
          }),
          TestSourceControlHost.layer({
            process: {
              run: (input) =>
                Effect.succeed(
                  input.command === "git"
                    ? output("https://forgejo.test/org/project.git")
                    : input.command === "tea" && input.args[0] === "login"
                      ? output(
                          encodeJson([
                            {
                              name: "team",
                              url: "https://gitea.test/team",
                              user: "team-user",
                              default: "true",
                              valid: "true",
                            },
                            {
                              name: "personal",
                              url: "https://forgejo.test",
                              user: "personal-user",
                              default: "false",
                              valid: "false",
                            },
                          ]),
                        )
                      : output("version"),
                ),
            },
          }),
        ),
      ),
    );
  },
);

it.effect("keeps tea connections visible when fj is missing", () =>
  Effect.gen(function* () {
    const spec = yield* ForgejoSourceControlProvider.makeDiscovery;
    if (spec.type !== "managed-cli") return yield* Effect.die("Expected managed discovery");
    const result = yield* spec.probe("/repo");
    assert.strictEqual(result.executable, "tea");
    assert.strictEqual(result.auth.instances?.length, 2);
    assert.deepStrictEqual(
      result.auth.instances?.map((entry) => entry.account),
      [Option.some("alice"), Option.some("bob")],
    );
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(ForgejoCli.ForgejoCli)({ listLogins: () => Effect.succeed([]) }),
        TestSourceControlHost.layer({
          process: {
            run: (input) =>
              input.command === "fj"
                ? Effect.fail(
                    new VcsProcessSpawnError({
                      operation: input.operation,
                      command: input.command,
                      cwd: input.cwd,
                      cause: new Error("not installed"),
                    }),
                  )
                : Effect.succeed(
                    input.command === "tea" && input.args[0] === "login"
                      ? output(
                          encodeJson([
                            {
                              name: "one",
                              url: "https://one.test",
                              user: "alice",
                              default: "true",
                              valid: "true",
                            },
                            {
                              name: "two",
                              url: "https://two.test",
                              user: "bob",
                              default: "false",
                              valid: "true",
                            },
                          ]),
                        )
                      : output("version"),
                  ),
          },
        }),
      ),
    ),
  ),
);
