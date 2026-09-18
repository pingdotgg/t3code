import * as Cloudflare from "@/Cloudflare";
import * as Effect from "effect/Effect";
import * as Output from "@/Output.ts";

export const publicationApplications = (contexts: {
  shared: string;
  other: string;
  changed: string;
}) =>
  Effect.gen(function* () {
    const first = yield* Cloudflare.Container("PublicationFirst", {
      context: contexts.shared,
      env: { SLOT: "first" },
      maxInstances: 2,
    }).Application;
    const second = yield* Cloudflare.Container("PublicationSecond", {
      context: contexts.shared,
      env: { SLOT: "second" },
      maxInstances: 3,
    }).Application;
    const other = yield* Cloudflare.Container("PublicationOtherContext", {
      context: contexts.other,
      maxInstances: 2,
    }).Application;
    const changed = yield* Cloudflare.Container("PublicationChangedContent", {
      context: contexts.changed,
      maxInstances: 2,
    }).Application;
    return { first, second, other, changed };
  });

export const historyApplications = (converge = false) =>
  Effect.gen(function* () {
    const target = converge
      ? yield* Cloudflare.Container("HistoryTarget", {
          image: "docker.io/alpine:3.19",
        }).Application
      : undefined;
    const image = target?.configuration.pipe(
      Output.map((configuration) => configuration.image),
    );
    const first = yield* Cloudflare.Container("HistoryFirst", {
      image: image ?? "alpine:3.19",
    }).Application;
    const second = yield* Cloudflare.Container("HistorySecond", {
      image: image ?? "alpine:3.20",
    }).Application;
    return { first, second, target };
  });

export const recoveryApplications = (delay: number, includeSecond = false) =>
  Effect.gen(function* () {
    const props = {
      dockerfile: {
        content: `FROM alpine:3.19\nRUN sleep ${delay}\nCMD ["sleep", "3600"]\n`,
      },
      maxInstances: 2,
    };
    const first = yield* Cloudflare.Container("RecoveryFirst", props)
      .Application;
    const second = includeSecond
      ? yield* Cloudflare.Container("RecoverySecond", props).Application
      : undefined;
    return { first, second };
  });
