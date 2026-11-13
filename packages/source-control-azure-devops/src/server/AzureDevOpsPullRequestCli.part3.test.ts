import { afterEach } from "@effect/vitest";
import { mockedExecute } from "./AzureDevOpsPullRequestCli.part2.testkit.ts";

afterEach(() => {
  mockedExecute.mockReset();
});
