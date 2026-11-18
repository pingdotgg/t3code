import type {
  OrbitTasksClient,
  OrbitTasksResult,
  OrbitTaskSummary,
} from "@t3tools/client-runtime/orbit-gateway";

/** The Gateway's largest page; the list follows the cursor up to MAX_PAGES. */
const PAGE_SIZE = 100;
const MAX_PAGES = 10;

export async function listAllTasks(
  client: Pick<OrbitTasksClient, "listTasks">,
): Promise<OrbitTasksResult<ReadonlyArray<OrbitTaskSummary>>> {
  const tasks: OrbitTaskSummary[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await client.listTasks({
      limit: PAGE_SIZE,
      ...(cursor === null ? {} : { cursor }),
    });
    if (result.status !== "ok") return result;
    tasks.push(...result.value.tasks);
    cursor = result.value.nextCursor;
    if (cursor === null) break;
  }
  return { status: "ok", value: tasks };
}
