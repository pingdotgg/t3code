// An agent may create a thread with neither a title nor a prompt; its name is then a placeholder
// that the first message should replace, unlike a title the caller chose.
export const placeholderThreadTitle = (parentTitle: string, index: number): string =>
  `${parentTitle} thread ${index + 1}`;

export const isPlaceholderThreadTitle = (title: string): boolean => / thread \d+$/u.test(title);
