import * as AWS from "@/AWS";
import * as Test from "@/Test/Vitest";
import { describe } from "@effect/vitest";

Test.make({ providers: AWS.providers() });

describe.skip("ApiGateway.BasePathMapping", () => {});
