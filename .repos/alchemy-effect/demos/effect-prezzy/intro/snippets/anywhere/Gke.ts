import * as Container from "@alchemy.run/gcp/Container";

export const Gke = Container.Cluster("Gke", { location: "us-central1", autopilot: true });
