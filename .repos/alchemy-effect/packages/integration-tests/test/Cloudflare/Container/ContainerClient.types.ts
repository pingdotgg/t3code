import * as Cloudflare from "@alchemy.run/cloudflare";
import type { Output } from "alchemy/Output";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

type Assert<T extends true> = T;
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
// `yield* Container` returns the handle.
type HandleOf<T> = T extends Effect.Effect<infer Handle, infer _E, infer _R> ? Handle : never;

// One Container is one image: the handle exposes its own image reference.
class Node extends Cloudflare.Container<Node>()("NodeTypes", {
  schedulingPolicy: "durable_object",
  image: "node:24-slim",
}) {}

class Python extends Cloudflare.Container<Python>()("PythonTypes", {
  schedulingPolicy: "durable_object",
  context: "./python",
}) {}

type _OwnImage = Assert<
  Equal<
    HandleOf<typeof Node>["image"],
    Effect.Effect<string, Cloudflare.Containers.ContainerError, RuntimeContext>
  >
>;

class ImageSource extends Context.Service<ImageSource, { image: string }>()(
  "container/types/ImageSource",
) {}

class Effectful extends Cloudflare.Container<Effectful>()(
  "EffectfulTypes",
  Effect.gen(function* () {
    const { image } = yield* ImageSource;
    return { schedulingPolicy: "durable_object" as const, image };
  }),
) {}

type _PreservesPropsRequirements = Assert<
  Equal<Extract<Effect.Services<typeof Effectful>, ImageSource>, ImageSource>
>;

const config = Cloudflare.Container("ConfigTypes", {
  schedulingPolicy: "durable_object",
  image: Config.succeed("alpine:3.21"),
});

const output = (image: Output<string>) =>
  Cloudflare.Container("OutputTypes", { schedulingPolicy: "durable_object", image });

const noImage = Cloudflare.Container("NoImageTypes", { schedulingPolicy: "durable_object" });

export const imageTypes = Effect.gen(function* () {
  const node = yield* Node;
  const python = yield* Python;
  // start() starts the Container's own image by default.
  yield* node.start({ instance: "lite", entrypoint: ["sleep", "infinity"], enableInternet: false });
  if (yield* node.running) yield* node.destroy();
  yield* python.start({ image: yield* python.image, enableInternet: false });
  // @ts-expect-error The named-image map was removed; one Container is one image.
  void node.images;
});

// Every image source accepts Inputs, and an image is optional.
export const declarations = [config, output, noImage];

export const removedImagesProp: Cloudflare.Containers.DurableObjectContainerProps = {
  schedulingPolicy: "durable_object",
  // @ts-expect-error Declare one Container per image instead of an image map.
  images: { shell: { image: "alpine:3.21" } },
};

export const removedClassName: Cloudflare.Containers.DurableObjectContainerProps = {
  schedulingPolicy: "durable_object",
  image: "alpine:3.21",
  // @ts-expect-error Attach to a class with Cloudflare.DurableObject(name, { containers }).
  className: "Agent",
};

// An async Durable Object binding attaches Containers to its class; one
// Container may be shared by several classes.
const AsyncNode = Cloudflare.Container("AsyncNodeTypes", {
  schedulingPolicy: "durable_object",
  image: "node:24-slim",
});
const AsyncRust = Cloudflare.Container("AsyncRustTypes", {
  schedulingPolicy: "durable_object",
  image: "rust:1.90-slim",
});
export const asyncClasses = {
  AGENT: Cloudflare.DurableObject("Agent", { containers: [AsyncNode] }),
  REVIEWER: Cloudflare.DurableObject("Reviewer", { containers: [AsyncNode, AsyncRust] }),
};

// Effect-native Durable Objects `yield*` their Containers; only the async
// binding form takes a `containers` prop.
export class EffectfulAgent extends Cloudflare.DurableObject<EffectfulAgent, {}>()(
  "EffectfulAgentTypes",
  {
    // @ts-expect-error `containers` is only for Cloudflare.DurableObject(name, props) in env.
    containers: [AsyncNode],
  },
) {}

export const invalidInstanceType: Cloudflare.Containers.DurableObjectContainerProps = {
  schedulingPolicy: "durable_object",
  // @ts-expect-error Instance sizes are selected by start(), not at deployment.
  instanceType: "lite",
};

export const settings: Cloudflare.Containers.DurableObjectContainerProps = {
  schedulingPolicy: "durable_object",
  image: "alpine:3.21",
  ssh: { enabled: true },
  observability: { logs: { enabled: true } },
};

type ClashingShape = { exec: (cmd: string) => Effect.Effect<string> };
// @ts-expect-error `exec` is reserved by the container handle, so an RPC method cannot shadow it.
export class Clash extends Cloudflare.Container<Clash, ClashingShape>()("ClashTypes") {}

type DistinctShape = { shell: (cmd: string) => Effect.Effect<string> };
export class Distinct extends Cloudflare.Container<Distinct, DistinctShape>()("DistinctTypes") {}

export const handleTypes = Effect.gen(function* () {
  const distinct = yield* Distinct;
  // RPC methods and handle methods live side by side.
  yield* distinct.start({ enableInternet: false });
  const _shell: Effect.Effect<string> = distinct.shell("ls");
  const port = yield* distinct.getTcpPort(8080);
  void port;
});

// Placement constraints accept a compliance jurisdiction and regions within it.
const euOnly = Cloudflare.Container("EuOnlyTypes", {
  schedulingPolicy: "durable_object",
  image: "node:24-slim",
  constraints: { jurisdiction: "eu", regions: ["WEUR", "EEUR"] },
});

// Open enums: values Cloudflare adds later need no alchemy release.
const newerPlacement: Cloudflare.Containers.ContainerApplication.Constraints = {
  jurisdiction: "apac",
  regions: ["NEWR"],
};

export const placements = [euOnly, newerPlacement];

// Network keys are camelCase, like every other prop; the SDK sends them as
// `assign_ipv4`. The API rejects anything else with `unrecognized key`.
const privateNetwork = Cloudflare.Container("PrivateNetworkTypes", {
  image: "node:24-slim",
  network: { assignIpv4: "none", assignIpv6: "none", mode: "private" },
});

const wireNameNetwork: Cloudflare.Containers.ContainerApplication.Network = {
  // @ts-expect-error wire names are not props; write `assignIpv4`.
  assign_ipv4: "none",
};

const unknownNetworkKey: Cloudflare.Containers.ContainerApplication.Network = {
  mode: "private",
  // @ts-expect-error the API rejects keys it does not know.
  ttl: 30,
};

export const networks = [privateNetwork, wireNameNetwork, unknownNetworkKey];
