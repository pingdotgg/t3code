import { assert, describe, it } from "@effect/vitest";
import { type OrchestrationV2ThreadShell, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { type ClientLaunch, forClientLaunch } from "./NewThreadDisplayMode.ts";

class LaunchFailed extends Schema.TaggedError<LaunchFailed>()("LaunchFailed", {}) {}

const threadId = ThreadId.make("thread:new-display-mode");
const failure = new LaunchFailed();

interface Case {
  readonly name: string;
  readonly launch?: ClientLaunch;
  readonly defaultMode?: string;
  readonly stored?: string;
  /** When a thread with the id exists: before the launch, or only once the launch ran. */
  readonly exists?: "before" | "after";
  readonly fails?: true;
  /** The thread lookup fails, so the mode cannot be checked. */
  readonly lookupFails?: true;
  /** The thread's entry when the launch ran, and after it. */
  readonly seen: string | undefined;
  readonly entry: string | undefined;
}

const cases: ReadonlyArray<Case> = [
  { name: "a new web thread gets the default", seen: "chat-replies", entry: "chat-replies" },
  {
    name: "a mobile thread keeps Normal",
    launch: { threadId, creationSource: "mobile" },
    seen: undefined,
    entry: undefined,
  },
  {
    name: "a launch with no creationSource keeps Normal",
    launch: { threadId },
    seen: undefined,
    entry: undefined,
  },
  {
    name: "a reused thread keeps its mode",
    launch: { threadId, creationSource: "web", reuseExistingThread: true },
    seen: undefined,
    entry: undefined,
  },
  {
    name: "a launch with no thread id writes nothing",
    launch: { creationSource: "web" },
    seen: undefined,
    entry: undefined,
  },
  {
    name: "an existing thread keeps its mode",
    exists: "before",
    seen: undefined,
    entry: undefined,
  },
  {
    name: "a Normal default removes a stale entry",
    defaultMode: "normal",
    stored: "chat-replies",
    seen: undefined,
    entry: undefined,
  },
  {
    name: "an unknown default keeps Normal",
    defaultMode: "no-such-mode",
    seen: undefined,
    entry: undefined,
  },
  {
    name: "a failed thread lookup still runs the launch in Normal",
    lookupFails: true,
    seen: undefined,
    entry: undefined,
  },
  {
    name: "a failed launch removes the entry",
    fails: true,
    seen: "chat-replies",
    entry: undefined,
  },
  {
    name: "a failed launch that created the thread keeps the entry",
    fails: true,
    exists: "after",
    seen: "chat-replies",
    entry: "chat-replies",
  },
];

describe("NewThreadDisplayMode.forClientLaunch", () => {
  it.effect.each(cases)("$name", (testCase) =>
    Effect.gen(function* () {
      const settings = yield* ServerSettings.ServerSettingsService;
      const created = yield* Ref.make(testCase.exists === "before");
      const seen = yield* Ref.make<string | undefined>(undefined);
      const entryNow = settings.getSettings.pipe(
        Effect.map((current) => current.threadDisplayModes[threadId]),
      );
      const launch = Effect.gen(function* () {
        yield* Ref.set(seen, yield* entryNow);
        if (testCase.exists === "after") yield* Ref.set(created, true);
        if (testCase.fails) return yield* failure;
      });
      const threads = Layer.mock(ThreadManagementService.ThreadManagementService)({
        getThreadShell: () =>
          testCase.lookupFails
            ? Effect.die("thread lookup failed")
            : Ref.get(created).pipe(
                Effect.map((exists) => (exists ? ({} as OrchestrationV2ThreadShell) : null)),
              ),
      });

      const error = yield* launch.pipe(
        forClientLaunch(testCase.launch ?? { threadId, creationSource: "web" }),
        Effect.provide(threads),
        Effect.match({ onFailure: (error) => error, onSuccess: () => undefined }),
      );

      assert.strictEqual(error, testCase.fails ? failure : undefined);
      assert.strictEqual(yield* Ref.get(seen), testCase.seen);
      assert.strictEqual(yield* entryNow, testCase.entry);
    }).pipe(
      Effect.provide(
        ServerSettings.layerTest({
          newThreadDisplayMode: testCase.defaultMode ?? "chat-replies",
          threadDisplayModes: testCase.stored === undefined ? {} : { [threadId]: testCase.stored },
        }),
      ),
    ),
  );
});
