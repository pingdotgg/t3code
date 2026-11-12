import { BetterAuth, Memory } from "@alchemy.run/better-auth";
import * as Domain from "@alchemy.run/domain";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { describe, expect, it } from "@effect/vitest";
import { RuntimeContext } from "alchemy";
import { genericOAuth } from "better-auth/plugins/generic-oauth";
import * as Effect from "effect/Effect";
import * as Cookies from "effect/http/Cookies";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpServer from "effect/http/HttpServer";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as Layer from "effect/Layer";
import { OAuth2Server } from "oauth2-mock-server";
import { Auth } from "../src/Auth.ts";
import { NotesModel } from "../src/Notes.model.ts";
import { NotesApi } from "../src/NotesApi.api.ts";
import { SessionLive } from "../src/Session.ts";
import { UserId } from "../src/User.id.ts";

// A local OpenID Connect provider stands in for GitHub and Google, which a test can't sign in to.
// `signingInAs` picks who the next sign-in is.
let signingInAs = { sub: "u-sam", name: "Sam", email: "sam@example.com" };
const Provider = Effect.acquireRelease(
  Effect.promise(async () => {
    const server = new OAuth2Server();
    await server.issuer.keys.generate("RS256");
    server.service.on("beforeTokenSigning", (token) => Object.assign(token.payload, signingInAs));
    server.service.on("beforeUserinfo", (userinfo) => {
      userinfo.body = { ...signingInAs, email_verified: true };
    });
    await server.start(0, "127.0.0.1");
    return server;
  }),
  (server) => Effect.promise(() => server.stop()),
);

// The same better-auth the Worker runs, plus the local provider, over an in-memory database.
const AuthTest = Layer.effect(
  Auth,
  Effect.gen(function* () {
    const provider = yield* Provider;
    const { address } = yield* HttpServer.HttpServer;
    return yield* BetterAuth({
      basePath: "/api/auth",
      baseURL: `http://127.0.0.1:${(address as { port: number }).port}`,
      secret: "a-test-secret-a-test-secret-a-test-secret",
      socialProviders: {
        github: { clientId: "github-client", clientSecret: "github-secret" },
        google: { clientId: "google-client", clientSecret: "google-secret" },
      },
      plugins: [
        genericOAuth({
          config: [
            {
              providerId: "local",
              discoveryUrl: `${provider.issuer.url}/.well-known/openid-configuration`,
              clientId: "notes",
              clientSecret: "notes-secret",
              pkce: true,
            },
          ],
        }),
      ],
    });
  }).pipe(Effect.provide(Memory()), Effect.provide(RuntimeContext.phantom)),
);

// The Worker's routes on a real HTTP server: better-auth under /api/auth, the NotesApi under /api.
const Served = Layer.unwrap(
  Effect.gen(function* () {
    const auth = yield* Auth;
    const api = yield* NotesApi;
    return HttpServer.serve()(
      Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        if (request.url.startsWith("/api/auth/")) return yield* auth.fetch;
        return yield* api.fetch;
      }).pipe(Effect.provide(RuntimeContext.phantom)),
    );
  }),
).pipe(
  Layer.provideMerge(
    SessionLive.pipe(
      Layer.provideMerge(AuthTest),
      Layer.provideMerge(NotesModel.layer(Layer.empty).pipe(Layer.provide(Domain.InMemory))),
    ),
  ),
  Layer.provideMerge(NodeHttpServer.layerTest),
);

/** Ask the app to start a sign-in; it answers with the provider URL to send the browser to. */
const startSignIn = Effect.fn(function* (path: string, body: object) {
  const client = yield* HttpClient.HttpClient;
  const response = yield* client.execute(
    HttpClientRequest.post(path).pipe(HttpClientRequest.bodyJsonUnsafe(body)),
  );
  return { response, body: (yield* response.json) as { url: string } };
});

/** Sign in through the local provider the way a browser does, and return its session cookie. */
const signIn = Effect.fn(
  function* (user: { sub: string; name: string; email: string }) {
    signingInAs = user;
    const client = yield* HttpClient.HttpClient;

    // The app sends the browser to the provider, with a state cookie.
    const started = yield* startSignIn("/api/auth/sign-in/social", {
      provider: "local",
      callbackURL: "/",
    });

    // The provider signs the user in and sends the browser back with a code.
    const provider = yield* HttpClient.HttpClient.pipe(Effect.provide(FetchHttpClient.layer));
    const authorized = yield* provider.get(started.body.url);
    const callback = new URL(authorized.headers.location!);

    // The app's callback exchanges the code and sets the session cookie.
    const done = yield* client.execute(
      HttpClientRequest.get(`${callback.pathname}${callback.search}`).pipe(
        HttpClientRequest.setHeader("cookie", Cookies.toCookieHeader(started.response.cookies)),
      ),
    );
    expect(done.status).toBe(302);
    return Cookies.toCookieHeader(Cookies.merge(started.response.cookies, done.cookies));
  },
  Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
);

/** A NotesApi client whose requests carry `cookie`, as a browser's do. */
const notesAs = (cookie: string) =>
  NotesApi.client.pipe(
    Effect.provide(
      Domain.protocolHttp("").pipe(
        Layer.provide(
          Layer.effect(
            HttpClient.HttpClient,
            Effect.map(
              HttpClient.HttpClient,
              HttpClient.mapRequest(HttpClientRequest.setHeader("cookie", cookie)),
            ),
          ),
        ),
      ),
    ),
  );

describe("sign-in with better-auth", () => {
  it.live("GitHub and Google send the browser to the provider, back to this app", () =>
    Effect.gen(function* () {
      const github = yield* startSignIn("/api/auth/sign-in/social", { provider: "github" });
      const toGitHub = new URL(github.body.url);
      expect(toGitHub.origin + toGitHub.pathname).toBe("https://github.com/login/oauth/authorize");
      expect(toGitHub.searchParams.get("client_id")).toBe("github-client");
      expect(new URL(toGitHub.searchParams.get("redirect_uri")!).pathname).toBe(
        "/api/auth/callback/github",
      );

      const google = yield* startSignIn("/api/auth/sign-in/social", { provider: "google" });
      const toGoogle = new URL(google.body.url);
      expect(toGoogle.origin + toGoogle.pathname).toBe(
        "https://accounts.google.com/o/oauth2/v2/auth",
      );
      expect(toGoogle.searchParams.get("client_id")).toBe("google-client");
      expect(new URL(toGoogle.searchParams.get("redirect_uri")!).pathname).toBe(
        "/api/auth/callback/google",
      );
    }).pipe(Effect.provide(Served), Effect.scoped),
  );

  it.live("a signed-in user writes and reads their own notes", () =>
    Effect.gen(function* () {
      const cookie = yield* signIn({ sub: "u-sam", name: "Sam", email: "sam@example.com" });
      const session = yield* (yield* Auth).getSession(new Headers({ cookie }));
      const sam = UserId.make(session!.user.id);

      const notes = yield* notesAs(cookie);
      yield* notes.WriteNote(sam, { text: "buy milk" });
      const read = yield* notes.Notes.get(sam);
      expect(read?.notes).toEqual(["buy milk"]);
    }).pipe(Effect.provide(RuntimeContext.phantom), Effect.provide(Served), Effect.scoped),
  );

  it.live("without a session, the Api refuses", () =>
    Effect.gen(function* () {
      const notes = yield* notesAs("");
      const refused = yield* notes.WriteNote(UserId.make("u-1"), { text: "hi" }).pipe(Effect.flip);
      expect(refused._tag).toBe("Unauthorized");
    }).pipe(Effect.provide(Served), Effect.scoped),
  );

  it.live("a user can't write in or read someone else's notebook", () =>
    Effect.gen(function* () {
      const samCookie = yield* signIn({ sub: "u-sam", name: "Sam", email: "sam@example.com" });
      const sam = UserId.make(
        (yield* (yield* Auth).getSession(new Headers({ cookie: samCookie })))!.user.id,
      );
      const alexCookie = yield* signIn({ sub: "u-alex", name: "Alex", email: "alex@example.com" });
      const alex = yield* notesAs(alexCookie);

      const write = yield* alex.WriteNote(sam, { text: "hi" }).pipe(Effect.flip);
      expect(write._tag).toBe("NotYours");
      const read = yield* alex.Notes.get(sam).pipe(Effect.flip);
      expect(read._tag).toBe("NotYours");
    }).pipe(Effect.provide(RuntimeContext.phantom), Effect.provide(Served), Effect.scoped),
  );
});
