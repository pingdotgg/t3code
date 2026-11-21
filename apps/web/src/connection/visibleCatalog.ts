import { visibleConnectionCatalog } from "@t3tools/client-runtime/state/connections";

import { environmentCatalog } from "./catalog";

export const visibleCatalogValueAtom = visibleConnectionCatalog(
  environmentCatalog.catalogValueAtom,
);
