import { containerEnvValue } from "@alchemy.run/kubernetes/internal/workload";
import { expect, test } from "@alchemy.run/test";
import { unwrapRedacted } from "alchemy/Util/data";
import { collectRedactedSecrets } from "alchemy/Util/Redaction";
import * as Redacted from "effect/Redacted";

test(
  "container env keeps Redacted values wrapped until they are sent",
  () => {
    const wrapped = containerEnvValue(Redacted.make("s3cr3t"));
    expect(Redacted.isRedacted(wrapped)).toBe(true);
    expect(JSON.stringify(unwrapRedacted({ value: wrapped }))).toBe('{"value":"s3cr3t"}');
    const objectEnv = containerEnvValue({ pin: Redacted.make("s3cr3t") });
    expect(Redacted.isRedacted(objectEnv)).toBe(true);
    expect(collectRedactedSecrets(objectEnv)).toEqual(['{"pin":"s3cr3t"}', "s3cr3t"]);
    expect(containerEnvValue({ pin: "plain" })).toBe('{"pin":"plain"}');
    const pin = containerEnvValue(Redacted.make(123456));
    expect(Redacted.isRedacted(pin)).toBe(true);
    expect(Redacted.isRedacted(pin) && Redacted.value(pin)).toBe("123456");
  },
  { tags: ["provider:kubernetes", "local"] },
);
