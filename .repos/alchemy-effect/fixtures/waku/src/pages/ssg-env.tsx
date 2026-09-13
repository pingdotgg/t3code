// TOP-LEVEL `cloudflare:workers` import in a statically rendered page: the
// SSG step of `waku build` imports this module while prerendering, so the
// build only succeeds when SSG runs inside workerd (the cloudflare vite
// plugin's preview mode serving the freshly built worker). In Node, loading
// the `cloudflare:` scheme throws ERR_UNSUPPORTED_ESM_URL_SCHEME.
import { env } from "cloudflare:workers";

export default async function SsgEnvPage() {
  return (
    <div>
      <div data-testid="ssg-env-marker">SSG_ENV_MARKER</div>
      <div data-testid="ssg-env-message">MESSAGE={String(env.MESSAGE ?? "unset")}</div>
    </div>
  );
}

// Static: prerendered at build time — with the binding value baked into the
// emitted HTML, proving the SSG render had real worker bindings.
export const getConfig = async () => ({ render: "static" }) as const;
