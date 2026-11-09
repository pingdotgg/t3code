import { describe, expect, test } from "@alchemy.run/test";
import * as Effect from "effect/Effect";
import {
  adapterLayer,
  resolve,
  type DnsAdapter,
  type DnsConfig,
  type DnsZone,
} from "@/DNS/Adapter";
import * as Output from "@/Output";

const TYPE = "Test.DNS";

describe("DNS adapter binding", { tags: ["unit", "local"] }, () => {
  test.effect("forwards deferred zones without resolving or replacing them", () =>
    Effect.gen(function* () {
      const deferredZone = Output.fromEffect(Effect.succeed("example.com"));
      const config = {
        type: TYPE,
        zone: deferredZone,
      } satisfies DnsConfig<typeof TYPE>;
      const seen: DnsZone[] = [];
      const adapter: DnsAdapter = {
        alias: (_id, args) =>
          Effect.sync(() => {
            seen.push(args);
          }),
        aliasSet: () => Effect.die("unexpected aliasSet invocation"),
        records: (_id, args) =>
          Effect.sync(() => {
            seen.push(args);
          }),
      };

      const dns = yield* resolve(config).pipe(Effect.provide(adapterLayer(TYPE, adapter)));
      yield* dns.alias("alias", {
        name: "www.example.com",
        target: { hostname: "target.example.com" },
      });

      expect(seen[0]?.zone).toBe(deferredZone);
    }),
  );

  test.effect("leaves an omitted zone undefined", () =>
    Effect.gen(function* () {
      const seen: DnsZone[] = [];
      const adapter: DnsAdapter = {
        alias: (_id, args) =>
          Effect.sync(() => {
            seen.push(args);
          }),
        aliasSet: () => Effect.die("unexpected aliasSet invocation"),
        records: (_id, args) =>
          Effect.sync(() => {
            seen.push(args);
          }),
      };

      const dns = yield* resolve({ type: TYPE }).pipe(Effect.provide(adapterLayer(TYPE, adapter)));
      yield* dns.alias("alias", {
        name: "www.example.com",
        target: { hostname: "target.example.com" },
      });

      expect(seen[0]?.zone).toBeUndefined();
    }),
  );
});
