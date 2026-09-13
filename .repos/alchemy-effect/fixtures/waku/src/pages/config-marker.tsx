// Imports a virtual module served by the USER vite plugin declared in
// waku.config.ts — this page (and with it the whole build) only works when
// the integration loads the user's config file natively and merges its own
// plugins over it instead of replacing it.
import { marker } from "virtual:fixtures-waku/user-config-marker";

export default async function ConfigMarkerPage() {
  return (
    <div>
      <div data-testid="config-marker">{marker}</div>
    </div>
  );
}

// Dynamic: served by the worker at request time in both live and dev modes,
// proving the user plugin participated in the server bundle.
export const getConfig = async () => ({ render: "dynamic" }) as const;
