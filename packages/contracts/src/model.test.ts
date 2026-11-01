import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { ModelCapabilities } from "./model.ts";

describe("ModelCapabilities", () => {
  const decode = Schema.decodeUnknownSync(ModelCapabilities);
  const encode = Schema.encodeSync(ModelCapabilities);
  const choice = { id: "cline-pass/mimo-v2.6-flash", label: "MiMo" };

  it("reads descriptors written before a select could mark that it selects the model", () => {
    const stored = {
      optionDescriptors: [{ id: "model", label: "Model", type: "select", options: [choice] }],
    };
    expect(decode(stored)).toEqual(stored);
  });

  it("keeps a model-selecting descriptor marked across the wire", () => {
    const capabilities = decode({
      optionDescriptors: [
        { id: "model", label: "Model", type: "select", selectsModel: true, options: [choice] },
      ],
    });
    expect(decode(JSON.parse(JSON.stringify(encode(capabilities))))).toEqual(capabilities);
    expect(capabilities.optionDescriptors?.[0]).toMatchObject({ selectsModel: true });
  });
});
