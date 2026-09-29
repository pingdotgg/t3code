import { providerAuthReturnUrl } from "@t3tools/shared/providerAuthReturnUrl";

export const codexAuthReturnUrl = providerAuthReturnUrl;

const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/gu,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!,
  );

export function codexAuthCallbackPage(
  success: boolean,
  returnUrl: string | undefined,
  nonce: string,
) {
  const destination = codexAuthReturnUrl(returnUrl);
  const title = success ? "You're signed in" : "Sign-in couldn't finish";
  const description = success
    ? destination
      ? "Returning to T3 Code. You're ready to continue."
      : "Return to T3 Code to continue. You can close this tab."
    : "Return to T3 Code and try signing in again.";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark"><title>${escapeHtml(title)} · T3 Code</title>
${success && destination ? `<meta http-equiv="refresh" content="1;url=${escapeHtml(destination)}">` : ""}
<style>
:root{font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#18181b;background:#fafafa;color-scheme:light dark}
*{box-sizing:border-box}body{margin:0;min-height:100svh;display:grid;place-items:center;padding:24px}
main{width:100%;max-width:440px;background:#fff;border:1px solid #e4e4e7;border-radius:20px;padding:32px;box-shadow:0 12px 40px #00000008}
.brand{font-size:18px;letter-spacing:-.5px;margin-bottom:36px;color:#71717a}.brand strong{color:#18181b}
.status{width:40px;height:40px;border-radius:50%;display:grid;place-items:center;background:${success ? "#ecfdf5" : "#fef2f2"};color:${success ? "#059669" : "#dc2626"};margin-bottom:20px}
h1{font-size:24px;font-weight:600;letter-spacing:-.7px;line-height:1.25;margin:0 0 12px}p{font-size:15px;line-height:1.6;color:#71717a;margin:0}
a{display:inline-flex;align-items:center;justify-content:center;margin-top:28px;padding:10px 16px;border-radius:8px;background:#2563eb;color:white;font-size:14px;font-weight:500;text-decoration:none}a:focus-visible{outline:3px solid #93c5fd;outline-offset:3px}
@media(prefers-color-scheme:dark){:root{color:#fafafa;background:#09090b}main{background:#18181b;border-color:#27272a;box-shadow:0 12px 40px #0003}.brand,p{color:#a1a1aa}.brand strong{color:#fafafa}.status{background:${success ? "#064e3b" : "#450a0a"};color:${success ? "#34d399" : "#f87171"}}}
</style></head><body><main><div class="brand"><strong>T3</strong> Code</div>
<div class="status" aria-hidden="true"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${success ? '<path d="m5 12 4 4L19 6"/>' : '<path d="m6 6 12 12M6 18 18 6"/>'}</svg></div>
<h1>${escapeHtml(title)}</h1><p>${description}</p>
${destination ? `<a href="${escapeHtml(destination)}">Return to T3 Code</a>` : ""}
</main><script nonce="${escapeHtml(nonce)}">history.replaceState(null,"","/auth/callback");</script></body></html>`;
}
