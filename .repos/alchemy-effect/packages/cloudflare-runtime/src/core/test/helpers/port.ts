import * as Effect from "effect/Effect";
import * as NodeNet from "node:net";
import * as Port from "../../internal/Port.ts";

export const occupy = (port: number, host?: string) =>
  Effect.acquireRelease(
    Effect.callback<NodeNet.Server>((resume) => {
      const server = NodeNet.createServer();
      server.once("error", (err) => resume(Effect.die(err)));
      server.listen({ port, host, exclusive: true }, () =>
        resume(Effect.succeed(server)),
      );
    }),
    (server) =>
      Effect.callback<void>((resume) => {
        server.close(() => resume(Effect.void));
      }),
  ).pipe(Effect.map((server) => server.address() as NodeNet.AddressInfo));

export const find = (port: number) =>
  Port.make({ cache: false }).pipe(Effect.flatMap((ports) => ports.find(port)));

export const check = (port: number) =>
  Port.make({ cache: false }).pipe(
    Effect.flatMap((ports) => ports.check(port)),
  );
