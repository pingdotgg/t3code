import * as GCP from "alchemy/GCP";

/**
 * The counter store: a BASIC-tier (single node, no replica) 1 GiB
 * Memorystore for Redis instance on the project's `default` network.
 *
 * `authEnabled` turns on Redis AUTH, so a client on the network still
 * needs the instance's AUTH string. Alchemy reads that string at deploy
 * time and hands it to the service with the private IP; nobody copies
 * it around by hand.
 *
 * Creating or deleting the instance takes several minutes.
 */
export const Counters = GCP.Redis.Instance("Counters", {
  tier: "BASIC",
  memorySizeGb: 1,
  authEnabled: true,
});
