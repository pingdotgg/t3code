/**
 * Connection details for a hyperdrive binding running in local mode.
 */
export interface HyperdriveOrigin {
  scheme: string;
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  sslmode?: string;
}
