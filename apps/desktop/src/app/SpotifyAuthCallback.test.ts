import { assert, it } from "@effect/vitest";

import { spotifyAuthorizationRequest } from "./SpotifyAuthCallback.ts";

const authorize = (
  overrides: Record<string, string> = {},
  origin = "https://accounts.spotify.com",
) =>
  `${origin}/authorize?${new URLSearchParams({
    client_id: "id",
    response_type: "code",
    redirect_uri: "http://127.0.0.1:8898/callback",
    code_challenge_method: "S256",
    code_challenge: "challenge",
    state: "abcdefghijklmnopqrstuvwx",
    ...overrides,
  }).toString()}`;

it("accepts only Spotify PKCE sign-ins that return to the registered loopback", () => {
  assert.equal(spotifyAuthorizationRequest(authorize()).state, "abcdefghijklmnopqrstuvwx");
  for (const url of [
    authorize({}, "https://evil.example"),
    authorize({ redirect_uri: "http://127.0.0.1:9999/callback" }),
    authorize({ code_challenge_method: "plain" }),
    authorize({ state: "short" }),
  ]) {
    assert.throws(() => spotifyAuthorizationRequest(url));
  }
});
