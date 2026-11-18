// Fork-only: maestro worker threads are titled `mw-<issue> <title>` (workflow/skills/ak/maestro).
const WORKER_THREAD_TITLE = /^mw-\d+ /;

export const isWorkerThreadTitle = (title: string) => WORKER_THREAD_TITLE.test(title);
