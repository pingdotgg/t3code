// @effect-diagnostics globalFetch:off - A one-off public probe from React screens, which run no Effect runtime.

/** Whether the server at `origin` offers Access sign-in; its public session descriptor says so. */
export const fetchCloudflareAccessLoginAvailable = async (
  origin: string,
  signal?: AbortSignal,
): Promise<boolean> => {
  try {
    const response = await fetch(`${origin}/api/auth/session`, {
      credentials: "omit",
      headers: { accept: "application/json" },
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) return false;
    const body: unknown = await response.json();
    return (
      typeof body === "object" &&
      body !== null &&
      "auth" in body &&
      typeof body.auth === "object" &&
      body.auth !== null &&
      "cloudflareAccessLogin" in body.auth &&
      body.auth.cloudflareAccessLogin === true
    );
  } catch {
    return false;
  }
};
