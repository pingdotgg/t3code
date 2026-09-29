import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { providerAuthReturnUrl } from "./providerAuthReturnUrl.ts";

export const CodexAuthHandoff = Schema.Struct({
  authorizationUrl: Schema.String.check(Schema.isMaxLength(16_384)),
  returnUrl: Schema.String.check(Schema.isMaxLength(4_096)),
  environmentId: EnvironmentId,
  instanceId: ProviderInstanceId,
  flowId: Schema.NonEmptyString.check(Schema.isMaxLength(128)),
});
export type CodexAuthHandoff = typeof CodexAuthHandoff.Type;
const Delivery = Schema.Struct({
  environmentId: EnvironmentId,
  instanceId: ProviderInstanceId,
  flowId: Schema.NonEmptyString.check(Schema.isMaxLength(128)),
  callbackUrl: Schema.String.check(Schema.isMaxLength(16_384)),
  returnHash: Schema.String.check(Schema.isMaxLength(128)),
});

const encodeHandoff = Schema.encodeSync(Schema.fromJsonString(CodexAuthHandoff));
const decodeHandoff = Schema.decodeUnknownSync(Schema.fromJsonString(CodexAuthHandoff));
const encodeDelivery = Schema.encodeSync(Schema.fromJsonString(Delivery));
const decodeDelivery = Schema.decodeUnknownSync(Schema.fromJsonString(Delivery));

/** The helper only opens OpenAI's authorize endpoint and receives a loopback callback. */
export function codexAuthorizationRequest(value: string) {
  const url = new URL(value);
  if (
    value.length > 16_384 ||
    url.origin !== "https://auth.openai.com" ||
    url.pathname !== "/api/accounts/authorize" ||
    url.username ||
    url.password ||
    url.hash
  )
    throw new Error("Invalid ChatGPT sign-in request.");
  const single = (key: string) => {
    const values = url.searchParams.getAll(key);
    if (values.length !== 1 || !values[0]) throw new Error("Invalid ChatGPT sign-in request.");
    return values[0];
  };
  const redirectUri = single("redirect_uri");
  const redirect = new URL(redirectUri);
  const state = single("state");
  if (
    !/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}\/auth\/callback$/u.test(redirectUri) ||
    Number(redirect.port) > 65_535 ||
    !/^[\w-]{16,128}$/u.test(state) ||
    single("response_type") !== "code" ||
    single("code_challenge_method") !== "S256" ||
    !/^[\w-]{43}$/u.test(single("code_challenge")) ||
    !/^(dynamic_agent_client|oaiapp_[\w-]+)$/u.test(single("client_id"))
  )
    throw new Error("Invalid ChatGPT sign-in request.");
  return { authorizationUrl: url.toString(), redirectUri, state };
}

/** Validation is shared by the desktop listener and the environment receiving the code. */
export function codexCallbackUrl(value: string, redirectUri: string, state: string) {
  const callback = new URL(value);
  const expected = new URL(redirectUri);
  const states = callback.searchParams.getAll("state");
  const codes = callback.searchParams.getAll("code");
  const errors = callback.searchParams.getAll("error");
  const clients = callback.searchParams.getAll("client_id");
  if (
    value.length > 16_384 ||
    callback.origin !== expected.origin ||
    callback.pathname !== expected.pathname ||
    callback.username ||
    callback.password ||
    callback.hash ||
    states.length !== 1 ||
    states[0] !== state ||
    clients.length > 1 ||
    (clients.length === 1 && !/^oaiapp_[\w-]+$/u.test(clients[0]!)) ||
    !(
      (codes.length === 1 && Boolean(codes[0]) && errors.length === 0) ||
      (errors.length === 1 && Boolean(errors[0]) && codes.length === 0)
    )
  )
    throw new Error("This redirect URL does not belong to the current sign-in.");
  return callback;
}

export function codexAuthHandoffUrl(input: CodexAuthHandoff, development = false) {
  const url = new URL(`${development ? "t3code-dev" : "t3code"}://auth/codex`);
  url.searchParams.set("request", encodeHandoff(input));
  return url.toString();
}

export function readCodexAuthHandoff(value: string, development: boolean) {
  try {
    const url = new URL(value);
    if (
      value.length > 32_768 ||
      url.protocol !== (development ? "t3code-dev:" : "t3code:") ||
      url.host !== "auth" ||
      url.pathname !== "/codex" ||
      url.username ||
      url.password ||
      url.hash ||
      url.searchParams.getAll("request").length !== 1
    )
      return undefined;
    const input = decodeHandoff(url.searchParams.get("request"));
    codexAuthorizationRequest(input.authorizationUrl);
    if (!providerAuthReturnUrl(input.returnUrl)) return undefined;
    return input;
  } catch {
    return undefined;
  }
}

/** Codes travel in a fragment, never in hosted web requests or a token store on the helper. */
export function codexAuthDeliveryUrl(input: CodexAuthHandoff, callbackUrl: string) {
  const request = codexAuthorizationRequest(input.authorizationUrl);
  codexCallbackUrl(callbackUrl, request.redirectUri, request.state);
  const destination = providerAuthReturnUrl(input.returnUrl);
  if (!destination) throw new Error("Invalid T3 Code return address.");
  const url = new URL(destination);
  const delivery = {
    environmentId: input.environmentId,
    instanceId: input.instanceId,
    flowId: input.flowId,
    callbackUrl,
    returnHash: url.hash,
  };
  url.hash = `codex-auth=${encodeURIComponent(encodeDelivery(delivery))}`;
  return url.toString();
}

export function readCodexAuthDelivery(value: string) {
  try {
    const url = new URL(value);
    if (!url.hash.startsWith("#codex-auth=") || url.hash.length > 32_768) return undefined;
    const input = decodeDelivery(decodeURIComponent(url.hash.slice("#codex-auth=".length)));
    const destination = providerAuthReturnUrl(value);
    if (!destination) return undefined;
    const returnUrl = new URL(destination);
    returnUrl.hash = input.returnHash;
    const sanitized = providerAuthReturnUrl(returnUrl.toString());
    if (!sanitized) return undefined;
    return { ...input, returnUrl: sanitized };
  } catch {
    return undefined;
  }
}
