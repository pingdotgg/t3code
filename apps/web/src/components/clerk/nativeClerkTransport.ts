interface NativeClerkRequest extends RequestInit {
  url?: URL;
}

/** Same client-JWT lifecycle as Clerk Electron, over the paired environment's HTTP transport. */
export function createNativeClerkTransport(input: {
  readonly frontendApi: string;
  readonly origin: string;
  readonly storage: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  readonly storageKey: string;
}) {
  return {
    beforeRequest(request: NativeClerkRequest) {
      const url = request.url;
      if (!url || url.origin !== input.frontendApi)
        throw new Error("Unexpected T3 Connect sign-in host.");
      const target = new URL("/api/connect/native-auth", input.origin);
      target.searchParams.set("path", url.pathname);
      target.searchParams.set("search", url.search);
      const headers = new Headers(request.headers);
      // Authorization belongs to the environment on this hop; the native
      // Clerk client credential travels in its own header.
      headers.delete("authorization");
      const token = input.storage.getItem(input.storageKey);
      if (token) headers.set("x-t3-clerk-client", token);
      request.headers = headers;
      request.credentials = "include";
      request.url = target;
    },
    afterResponse(_request: NativeClerkRequest, response?: Response) {
      const authorization = response?.headers.get("x-t3-clerk-client");
      if (!authorization) return;
      const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : authorization;
      input.storage.setItem(input.storageKey, token);
    },
  };
}
