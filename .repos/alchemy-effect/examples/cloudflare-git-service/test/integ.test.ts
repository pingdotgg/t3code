/**
 * The example, end to end: a user signs up with Better Auth, creates a
 * repository through the app's API, mints an API key, and pushes with it.
 * A second user can read the public repository but cannot push to it, and
 * an unknown key is anonymous. Run with `bun test` from this directory.
 */
import * as Cloudflare from "alchemy/Cloudflare";
import * as Test from "alchemy/Test/Bun";
import { expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import Stack from "../alchemy.run.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
  state: Cloudflare.state(),
  stage: "test",
});

const stack = beforeAll(deploy(Stack), { timeout: 600_000 });

afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), {
  timeout: 600_000,
});

interface JsonResponse {
  readonly status: number;
  readonly json: any;
  readonly cookie: string;
}

/** A JSON request that carries and captures the session cookie. */
const call = (
  url: string,
  path: string,
  options: {
    readonly method?: string;
    readonly body?: unknown;
    readonly cookie?: string;
  } = {},
) =>
  Effect.tryPromise(async (signal): Promise<JsonResponse> => {
    const response = await fetch(`${url}${path}`, {
      method: options.method ?? (options.body === undefined ? "GET" : "POST"),
      signal,
      headers: {
        // Browsers send Origin on every request; Better Auth requires it on
        // cookie-authenticated writes (CSRF).
        origin: url,
        ...(options.body !== undefined
          ? { "content-type": "application/json" }
          : {}),
        ...(options.cookie ? { cookie: options.cookie } : {}),
      },
      body:
        options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
    const text = await response.text();
    let json: unknown = null;
    try {
      json = text.length === 0 ? null : JSON.parse(text);
    } catch {
      json = text;
    }
    const cookie = response.headers
      .getSetCookie()
      .map((c) => c.split(";")[0]!)
      .join("; ");
    return {
      status: response.status,
      json,
      cookie: cookie || (options.cookie ?? ""),
    };
  }).pipe(
    // A fresh workers.dev rollout may answer before the request reaches the app.
    // Retry only Cloudflare's own missing-route response, including for POSTs.
    Effect.repeat({
      while: (response) =>
        typeof response.json === "string" &&
        ((response.status === 404 &&
          response.json.includes("<title>Page not found</title>")) ||
          response.json.trim() === "error code: 1042"),
      schedule: Schedule.spaced("2 seconds"),
      times: 5,
    }),
  );

/** Sign a user up (or in, when the account survived a NO_DESTROY run) and return the session cookie. */
const signIn = Effect.fn(function* (
  url: string,
  user: { name: string; email: string; password: string },
) {
  const up = yield* call(url, "/api/auth/sign-up/email", { body: user });
  const session =
    up.status === 200
      ? up
      : yield* call(url, "/api/auth/sign-in/email", {
          body: { email: user.email, password: user.password },
        });
  expect(session.status).toBe(200);
  // Owner names are lowercased by the host; a Better Auth id is mixed-case.
  return {
    cookie: session.cookie,
    id: (session.json.user.id as string).toLowerCase(),
  };
});

class GitError extends Error {
  constructor(
    readonly args: string[],
    readonly code: number,
    readonly stderr: string,
  ) {
    super(`git ${args.join(" ")} exited ${code}: ${stderr}`);
  }
}

/** Run git with a hermetic identity; fails with the exit code and stderr. */
const git = (cwd: string, ...args: string[]) =>
  Effect.tryPromise({
    try: async () => {
      const proc = Bun.spawn(["git", ...args], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_TRACE_CURL: process.env.GIT_TRACE_CURL ?? "",
          GIT_AUTHOR_NAME: "integ",
          GIT_AUTHOR_EMAIL: "integ@example.com",
          GIT_COMMITTER_NAME: "integ",
          GIT_COMMITTER_EMAIL: "integ@example.com",
        },
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      if (code !== 0) throw new GitError(args, code, stderr);
      return stdout;
    },
    catch: (cause) =>
      cause instanceof GitError ? cause : new GitError(args, -1, String(cause)),
  });

const remoteWith = (url: string, key: string, owner: string, name: string) =>
  url.replace("://", `://x:${key}@`) + `/${owner}/${name}.git`;

test(
  "sign up, create a repository, push with an API key; a stranger reads but cannot push",
  Effect.gen(function* () {
    const { webUrl } = yield* stack;
    const url = webUrl.replace(/\/+$/, "");
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    // The front door forwards /api/** to the host; wait for it to answer
    // (anonymous listing is the middleware's 401).
    yield* call(url, "/api/v1/repos").pipe(
      Effect.filterOrFail(
        (r) => r.status === 200 || r.status === 401,
        () => new Error("not ready"),
      ),
      Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 60 }),
    );

    const owner = yield* signIn(url, {
      name: "Dana",
      email: "dana@example.com",
      password: "correct-horse-battery",
    });

    // Create a public repository under the owner's id. A previous run
    // (NO_DESTROY) may have left one: delete it and wait for the purge.
    const name = "web";
    yield* call(url, `/api/v1/repos/${owner.id}/${name}`, {
      method: "DELETE",
      cookie: owner.cookie,
    });
    yield* call(url, `/api/v1/repos/${owner.id}/${name}`, {
      cookie: owner.cookie,
    }).pipe(
      Effect.filterOrFail(
        (r) => r.status === 404,
        () => new Error("draining"),
      ),
      Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 60 }),
    );
    const created = yield* call(url, "/api/v1/repos", {
      body: { owner: owner.id, name, public: true },
      cookie: owner.cookie,
    });
    expect(created.status).toBe(200);
    expect(created.json.repo.owner).toBe(owner.id);

    // Mint an API key: the password of the git remote.
    const minted = yield* call(url, "/api/auth/api-key/create", {
      body: { name: "laptop" },
      cookie: owner.cookie,
    });
    expect(minted.status, JSON.stringify(minted.json)).toBe(200);
    const key: string = minted.json.key;
    expect(key.length).toBeGreaterThan(10);

    // Push with it.
    const tmp = yield* fs.makeTempDirectory({ prefix: "git-example-" });
    const work = path.join(tmp, "work");
    yield* fs.makeDirectory(work);
    yield* git(work, "init", "-q", "-b", "main");
    yield* fs.writeFileString(path.join(work, "README.md"), "# hello\n");
    yield* git(work, "add", "-A");
    yield* git(work, "commit", "-qm", "first");
    yield* git(
      work,
      "push",
      "-q",
      remoteWith(url, key, owner.id, name),
      "main",
    );

    // The owner's session sees the branch through the API.
    const refs = yield* call(url, `/api/v1/repos/${owner.id}/${name}/refs`, {
      cookie: owner.cookie,
    });
    expect(refs.status).toBe(200);
    expect(
      refs.json.refs.some(
        (r: { name: string }) => r.name === "refs/heads/main",
      ),
    ).toBe(true);

    // Anonymous clone of a public repository needs no credential.
    const anon = path.join(tmp, "anon");
    yield* git(tmp, "clone", "-q", `${url}/${owner.id}/${name}.git`, "anon");
    yield* git(anon, "fsck", "--strict");

    // A stranger: reads, cannot push.
    const stranger = yield* signIn(url, {
      name: "Alex",
      email: "alex@example.com",
      password: "correct-horse-battery",
    });
    const strangerKey = yield* call(url, "/api/auth/api-key/create", {
      body: { name: "laptop" },
      cookie: stranger.cookie,
    });
    yield* fs.writeFileString(path.join(anon, "README.md"), "# nope\n");
    yield* git(anon, "commit", "-qam", "nope");
    const denied = yield* git(
      anon,
      "push",
      "-q",
      remoteWith(url, strangerKey.json.key, owner.id, name),
      "main",
    ).pipe(Effect.result);
    expect(denied._tag).toBe("Failure");

    // An unknown key is anonymous: the private setting turns reads off too.
    yield* call(url, `/api/v1/repos/${owner.id}/${name}`, {
      method: "PATCH",
      body: { public: false },
      cookie: owner.cookie,
    });
    const hidden = yield* call(url, `/api/v1/repos/${owner.id}/${name}`);
    expect(hidden.status).toBe(401);
    // A private repository answers 401 to anyone but its owner, signed
    // in or not, so its existence is not confirmed.
    const strangerRead = yield* call(url, `/api/v1/repos/${owner.id}/${name}`, {
      cookie: stranger.cookie,
    });
    expect(strangerRead.status).toBe(401);
  }),
  { timeout: 300_000 },
);
