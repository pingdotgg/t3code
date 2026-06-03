import * as AWS from "@/AWS";
import * as Test from "@/Test/Vitest";
import { describe, it } from "vitest";

Test.make({ providers: AWS.providers() });

describe("ApiGateway bindings", () => {
  it.skip("placeholder — no runtime bindings for REST v1 in this slice", () => {});
});
