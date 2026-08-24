import * as Alchemy from "alchemy";
import * as Docker from "alchemy/Docker";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

const POSTGRES_PORT = 15432;
const POSTGRES_CONTAINER = "alchemy-example-postgres";

export default Alchemy.Stack(
  "DockerPostgresExample",
  {
    providers: Layer.merge(Docker.providers(), Alchemy.RandomProvider()),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const configuredPassword = yield* Config.redacted("POSTGRES_PASSWORD").pipe(
      Config.option,
    );
    const password = yield* Option.match(configuredPassword, {
      onSome: Effect.succeed,
      onNone: () => Alchemy.makeRandom("PostgresPassword", { bytes: 16 }),
    });

    const image = yield* Docker.RemoteImage("postgres-image", {
      name: "postgres",
      tag: "18-alpine",
      alwaysPull: false,
    });
    const network = yield* Docker.Network("app-network");
    const data = yield* Docker.Volume("postgres-data");

    const postgres = yield* Docker.Container("postgres", {
      name: POSTGRES_CONTAINER,
      image,
      environment: {
        POSTGRES_DB: "app",
        POSTGRES_USER: "alchemy",
        POSTGRES_PASSWORD: password,
      },
      ports: [{ external: POSTGRES_PORT, internal: 5432 }],
      volumes: [
        {
          hostPath: data.name,
          containerPath: "/var/lib/postgresql/data",
        },
      ],
      networks: [{ name: network.name, aliases: ["postgres"] }],
      healthcheck: {
        cmd: ["CMD-SHELL", "pg_isready -U alchemy -d app"],
        interval: "5 seconds",
        timeout: "5 seconds",
        retries: 10,
      },
      start: true,
    });
    return {
      container: postgres.name,
      image: image.imageRef,
      network: network.name,
      volume: data.name,
      hostPort: postgres.ports,
    };
  }),
);
