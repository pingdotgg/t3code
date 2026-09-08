import type { HyperdriveOrigin } from "./HyperdriveOrigin.shared.ts";

// For some reason, this only works as a dynamic import; otherwise the module is not found.
const { connect } = await import("cloudflare:sockets");

export default function makeBinding(env: { ORIGIN: HyperdriveOrigin }) {
  let connectionString = `${env.ORIGIN.scheme}://${env.ORIGIN.user}:${env.ORIGIN.password}@${env.ORIGIN.host}:${env.ORIGIN.port}/${env.ORIGIN.database}`;
  if (env.ORIGIN.sslmode) {
    connectionString += `?${env.ORIGIN.scheme === "postgresql" || env.ORIGIN.scheme === "postgres" ? "sslmode" : "ssl-mode"}=${env.ORIGIN.sslmode}`;
  }
  return {
    connect: () =>
      connect({ hostname: env.ORIGIN.host, port: env.ORIGIN.port }),
    connectionString,
    database: env.ORIGIN.database,
    user: env.ORIGIN.user,
    password: env.ORIGIN.password,
    host: env.ORIGIN.host,
    port: env.ORIGIN.port,
    // Production Hyperdrive exposes a synthetic IPv4 literal for drivers that
    // reject hostnames; locally the origin host is directly connectable, so
    // it doubles as the "ip" (drivers pass it back into connect(), which
    // accepts hostnames).
    ip: env.ORIGIN.host,
  } satisfies Hyperdrive;
}
