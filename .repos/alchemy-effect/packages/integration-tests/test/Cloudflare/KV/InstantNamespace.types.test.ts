import * as KV from "@alchemy.run/cloudflare/KV";
import { expect, test } from "@alchemy.run/test";
import type { Input } from "alchemy/Input";
import * as Effect from "effect/Effect";

const typeCases = (
  classic: KV.Namespace,
  instant: KV.InstantNamespace,
  either: KV.Namespace | KV.InstantNamespace,
  input: Input<KV.Namespace | KV.InstantNamespace>,
) =>
  Effect.gen(function* () {
    const classicRead = yield* KV.ReadNamespace(classic);
    yield* classicRead.getWithMetadata("key");
    yield* classicRead.list({ cursor: "cursor", limit: 1 });
    const classicWrite = yield* KV.WriteNamespace(classic);
    yield* classicWrite.put("key", "value", { metadata: { allowed: true } });
    const classicBoth = yield* KV.ReadWriteNamespace(Effect.succeed(classic));
    yield* classicBoth.getWithMetadata("key");
    yield* classicBoth.put("key", "value", { metadata: {} });

    const instantRead = yield* KV.ReadNamespace(instant);
    // @ts-expect-error Instant clients do not expose metadata.
    instantRead.getWithMetadata("key");
    // @ts-expect-error Instant listing does not accept pagination.
    instantRead.list({ limit: 1 });
    const instantWrite = yield* KV.WriteNamespace(instant);
    // @ts-expect-error Instant puts do not accept metadata.
    instantWrite.put("key", "value", { metadata: {} });

    const read = yield* KV.ReadNamespace(either);
    yield* read.get("key");
    // @ts-expect-error A union client must be safe for Instant.
    read.list({ cursor: "cursor" });
    const write = yield* KV.WriteNamespace(Effect.succeed(either));
    yield* write.put("key", "value");
    // @ts-expect-error A union client must be safe for Instant.
    write.put("key", "value", { metadata: {} });
    const both = yield* KV.ReadWriteNamespace(input);
    yield* both.list({ prefix: "key" });
    yield* both.delete("key");
    // @ts-expect-error A union client must be safe for Instant.
    both.getWithMetadata("key");

    const bind = yield* KV.ReadWriteNamespace;
    const bound = yield* bind(either);
    yield* bound.put("key", "value");
    // @ts-expect-error The service shape also narrows union clients.
    bound.put("key", "value", { metadata: {} });
  });

test.effect(
  "KV capability overloads preserve classic and Instant APIs",
  () =>
    Effect.sync(() => {
      expect(typeof typeCases).toBe("function");
    }),
  { tags: ["unit", "provider:cloudflare", "provider:cloudflare:kv", "local"] },
);
