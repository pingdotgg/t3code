import { ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  PROVIDER_CLIENT_DEFINITIONS,
  PROVIDER_CLIENT_DEFINITION_BY_VALUE,
} from "./providerDriverMeta";
import { PROVIDER_ICON_BY_PROVIDER } from "../chat/providerIconUtils";
import { PROVIDER_OPTIONS } from "../../session-logic";

const PI_AGENT = ProviderDriverKind.make("piAgent");

describe("Pi provider client wiring", () => {
  it("registers Pi as a real driver option with settings schema", () => {
    const definition = PROVIDER_CLIENT_DEFINITIONS.find((entry) => entry.value === PI_AGENT);
    expect(definition).toBeDefined();
    expect(definition?.label).toBe("Pi");
    expect(definition?.settingsSchema).toBeDefined();
  });

  it("maps the piAgent driver kind to a provider icon", () => {
    expect(PROVIDER_ICON_BY_PROVIDER[PI_AGENT]).toBeDefined();
  });

  it("advertises Pi as available in the provider picker", () => {
    const option = PROVIDER_OPTIONS.find((entry) => entry.value === PI_AGENT);
    expect(option).toBeDefined();
    expect(option?.label).toBe("Pi");
    expect(option?.available).toBe(true);
  });

  it("looks up the Pi definition by driver kind", () => {
    expect(PROVIDER_CLIENT_DEFINITION_BY_VALUE[PI_AGENT]?.label).toBe("Pi");
  });
});
