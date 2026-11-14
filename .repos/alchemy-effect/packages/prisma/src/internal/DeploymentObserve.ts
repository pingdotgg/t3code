import { getDeployment } from "@distilled.cloud/prisma/management";
import * as Effect from "effect/Effect";

export const observeDeployment = (deploymentId: string) =>
  getDeployment({ deploymentId }).pipe(Effect.map((response) => response.data));
