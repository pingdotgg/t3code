import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import type { SourceControlSshPasswordPromptRequest } from "@t3tools/contracts";

import * as SourceControlSshPasswordPrompts from "./SourceControlSshPasswordPrompts.ts";

it.effect("routes a source-control SSH prompt response back to the waiting publish", () =>
  Effect.gen(function* () {
    const prompts = yield* SourceControlSshPasswordPrompts.make();
    const published = yield* Deferred.make<SourceControlSshPasswordPromptRequest>();
    const prompt = prompts.makePrompt((request) =>
      Deferred.succeed(published, request).pipe(Effect.asVoid),
    );
    const waiting = yield* prompt
      .request({
        destination: "git@github.com:octocat/t3code.git",
        username: null,
        prompt: "Enter the SSH key passphrase or password.",
        attempt: 1,
      })
      .pipe(Effect.forkChild({ startImmediately: true }));
    const request = yield* Deferred.await(published);

    assert.equal(request.destination, "git@github.com:octocat/t3code.git");
    assert.equal(request.attempt, 1);
    assert.equal(request.expiresInMs, 3 * 60 * 1_000);
    yield* prompts.resolve({
      requestId: request.requestId,
      password: "correct horse battery staple",
    });
    assert.equal(yield* Fiber.join(waiting), "correct horse battery staple");
  }),
);

it.effect("treats a source-control SSH prompt timeout as cancellation", () =>
  Effect.gen(function* () {
    const prompts = yield* SourceControlSshPasswordPrompts.make({ promptTimeoutMs: 60_000 });
    const published = yield* Deferred.make<SourceControlSshPasswordPromptRequest>();
    const prompt = prompts.makePrompt((request) =>
      Deferred.succeed(published, request).pipe(Effect.asVoid),
    );
    const waiting = yield* prompt
      .request({
        destination: "github.com",
        username: null,
        prompt: "Enter the SSH key passphrase or password.",
        attempt: 1,
      })
      .pipe(Effect.forkChild({ startImmediately: true }));
    yield* Deferred.await(published);
    yield* TestClock.adjust("60 seconds");

    assert.equal(yield* Fiber.join(waiting), null);
  }),
);
