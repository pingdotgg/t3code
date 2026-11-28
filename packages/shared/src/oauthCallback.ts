/**
 * The address an OAuth sign-in sent the browser back to, as the user pasted it,
 * if it answers this sign-in: the redirect's own address, its one state, and
 * one code or one error. Throws otherwise.
 */
export function oauthCallbackUrl(value: string, redirectUri: string, state: string) {
  const expected = new URL(redirectUri);
  const callback = pastedUrl(value, expected.protocol);
  const states = callback.searchParams.getAll("state");
  const codes = callback.searchParams.getAll("code");
  const errors = callback.searchParams.getAll("error");
  if (
    value.length > 16_384 ||
    callback.origin !== expected.origin ||
    callback.pathname !== expected.pathname ||
    callback.username ||
    callback.password ||
    callback.hash ||
    states.length !== 1 ||
    states[0] !== state ||
    !(
      (codes.length === 1 && Boolean(codes[0]) && errors.length === 0) ||
      (errors.length === 1 && Boolean(errors[0]) && codes.length === 0)
    )
  )
    throw new Error("This redirect URL does not belong to the current sign-in.");
  return callback;
}

/** A URL copied from an address bar, which can hide its `http://`. Throws if it isn't one. */
export function pastedUrl(value: string, protocol = "http:") {
  const pasted = value.trim();
  return new URL(/^[a-z][a-z\d+.-]*:\/\//iu.test(pasted) ? pasted : `${protocol}//${pasted}`);
}
