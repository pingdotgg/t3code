import type { PrismaManagementClient } from "../Client.ts";

export const observeDeployment = (
  client: PrismaManagementClient,
  deploymentId: string,
) => client.getDeployment(deploymentId);
