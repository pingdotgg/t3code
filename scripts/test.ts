import aiLoopSuite from "./tests/ai-loop.spec";
import portPolicySuite from "./tests/port-policy.spec";
import planLintSuite from "./tests/plan-lint.spec";
import planStatusSuite from "./tests/plan-status.spec";
import preflightSuite from "./tests/preflight.spec";

type TestCase = {
  name: string;
  run: () => Promise<void> | void;
};

const suites: TestCase[] = [
  ...aiLoopSuite,
  ...portPolicySuite,
  ...planLintSuite,
  ...planStatusSuite,
  ...preflightSuite,
];

let failures = 0;

for (const suite of suites) {
  try {
    await suite.run();
    console.log(`ok - ${suite.name}`);
  } catch (error) {
    failures += 1;
    console.error(`not ok - ${suite.name}`);
    console.error(error);
  }
}

if (failures > 0) {
  throw new Error(`${failures} test(s) failed.`);
}
