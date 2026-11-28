import { requestConfirmDialog } from "~/confirmDialog";

/**
 * Prompts the user with T3 Code's themed destructive confirm dialog.
 * Fails closed (`false`) if no confirm dialog host is mounted.
 */
export async function confirmTeamDestructiveAction(message: string): Promise<boolean> {
  return (await requestConfirmDialog(message, { variant: "destructive" })) ?? false;
}
