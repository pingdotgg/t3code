import { generateKeyPair, SignJWT } from "jose";
import { expect, it, vi } from "vite-plus/test";
import { authorizeCacheWrite, authorizeTelemetry } from "./telemetryAuth.ts";
import { authorize, ISSUER } from "../vendor/vite-plus-remote-cache-cloudflare/src/auth.ts";

it("accepts signed stacked PR telemetry without granting cache writes or trusting another repository", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(1_000_000);
  try {
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const scope = {
      scope_id: "t3code",
      endpoint: "https://cache.example/projects/t3code",
      repository_id: "123",
      repository_owner_id: "456",
      branch: "refs/heads/main",
      policy_version: 1,
      writes_enabled: 0,
      pull_requests: 0,
    };
    const token = async (repository_id: string, audience = scope.endpoint) =>
      new SignJWT({
        repository_id,
        repository_owner_id: "456",
        repository_visibility: "public",
        event_name: "pull_request",
        ref: "refs/pull/42/merge",
        ref_type: "branch",
        base_ref: "feature/parent",
        actor: "maria",
      })
        .setProtectedHeader({ alg: "RS256", kid: "test" })
        .setIssuer(ISSUER)
        .setAudience(audience)
        .setIssuedAt(1000)
        .setNotBefore(1000)
        .setExpirationTime(1600)
        .sign(privateKey);
    const request = (token: string) =>
      new Request(scope.endpoint, { headers: { Authorization: `Bearer ${token}` } });
    const keys = async () => publicKey;
    const valid = request(await token("123"));
    const allowed = {
      ...scope,
      writes_enabled: 1,
      pull_requests: 1,
      branch: "refs/heads/feature/parent",
    };
    expect(
      await authorizeCacheWrite(
        request(await token("123", "https://ci-reader:secret@cache.example/projects/t3code")),
        allowed,
        keys,
      ),
    ).toMatchObject({ repository_id: "123" });
    await expect(
      authorizeCacheWrite(
        request(await token("123", "https://ci-reader:secret@other.example/projects/t3code")),
        allowed,
        keys,
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(await authorizeTelemetry(valid, scope, keys)).toBe("github/maria");
    await expect(
      authorizeCacheWrite(valid, { ...allowed, pull_requests: 0 }, keys),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      authorizeCacheWrite(valid, { ...allowed, branch: "refs/heads/main" }, keys),
    ).rejects.toMatchObject({ status: 403 });
    await expect(authorize(valid, scope, keys)).rejects.toMatchObject({ status: 403 });
    await expect(authorizeCacheWrite(valid, scope, keys)).rejects.toMatchObject({ status: 403 });
    expect(await authorizeCacheWrite(valid, allowed, keys)).toMatchObject({
      repository_id: "123",
    });
    await expect(
      authorizeCacheWrite(request(await token("another-repo")), allowed, keys),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      authorizeTelemetry(request(await token("another-repo")), scope, keys),
    ).rejects.toMatchObject({ status: 403 });
  } finally {
    vi.useRealTimers();
  }
});
