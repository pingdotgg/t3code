// Lets the header's pull request pill reach the git actions control, which owns the create flow:
// its progress stages, its default-ref confirmation, and the toast that reports the result. The
// two sit in different corners of the header, so a shared parent would have to thread that state
// through everything between them.
const CREATE_PULL_REQUEST_EVENT = "t3code:create-pull-request";

export function requestCreatePullRequest(): void {
  window.dispatchEvent(new CustomEvent(CREATE_PULL_REQUEST_EVENT));
}

export function onRequestCreatePullRequest(listener: () => void): () => void {
  window.addEventListener(CREATE_PULL_REQUEST_EVENT, listener);
  return () => window.removeEventListener(CREATE_PULL_REQUEST_EVENT, listener);
}
