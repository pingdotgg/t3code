// Thread and scheduled-task lists render titles on one line.
export const firstLineTitle = (title: string | undefined): string | undefined =>
  title
    ?.split(/[\r\n\u2028\u2029]/)
    .find((line) => line.trim().length > 0)
    ?.trim();
