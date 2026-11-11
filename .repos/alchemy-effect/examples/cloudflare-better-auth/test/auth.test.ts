import { expect, test } from "bun:test";

const baseURL = process.env.BETTER_AUTH_TEST_URL;

test.skipIf(!baseURL)(
  "same-origin authentication lifecycle",
  async () => {
    const origin = new URL(baseURL!).origin;
    const cookies = new Map<string, string>();
    const request = async (path: string, body?: object) => {
      const response = await fetch(new URL(path, origin), {
        method: body ? "POST" : "GET",
        headers: {
          origin,
          "content-type": "application/json",
          cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join("; "),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(10_000),
      });
      for (const cookie of response.headers.getSetCookie()) {
        const pair = cookie.split(";", 1)[0]!;
        const separator = pair.indexOf("=");
        cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
      }
      return response;
    };

    expect(await (await request("/api/health")).json()).toEqual({ ok: true });
    expect((await request("/")).status).toBe(200);
    expect((await request("/ui.js")).status).toBe(200);
    expect((await request("/api/providers")).status).toBe(200);
    expect((await request("/api/auth-not-a-route")).status).toBe(404);
    expect((await request("/api/me")).status).toBe(401);

    const user = {
      name: "Local Example User",
      email: `example-${crypto.randomUUID()}@example.com`,
      password: "local-example-password-123",
    };
    const signup = await request("/api/auth/sign-up/email", user);
    expect(signup.status).toBe(200);
    expect(cookies.size).toBeGreaterThan(0);
    const me = await request("/api/me");
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({
      name: user.name,
      email: user.email,
    });
    const session = await request("/api/auth/get-session");
    expect(session.status).toBe(200);
    expect(await session.json()).toMatchObject({ user: { email: user.email } });

    expect((await request("/api/auth/sign-out", {})).status).toBe(200);
    expect((await request("/api/me")).status).toBe(401);
    expect(await (await request("/api/auth/get-session")).json()).toBeNull();
    expect((await request("/api/health")).status).toBe(200);

    expect((await request("/api/auth/sign-in/email", user)).status).toBe(200);
    expect((await request("/api/me")).status).toBe(200);
    expect((await request("/api/auth/sign-out", {})).status).toBe(200);
    expect((await request("/api/me")).status).toBe(401);
  },
  45_000,
);
