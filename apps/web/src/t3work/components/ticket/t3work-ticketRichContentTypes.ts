export type JiraAttachment = {
  id?: string | undefined;
  filename?: string | undefined;
  mimeType?: string | undefined;
  content?: string | undefined;
  thumbnail?: string | undefined;
  size?: number | undefined;
};

export type JiraCommentItem = {
  id?: string | undefined;
  author?: string | undefined;
  created?: string | undefined;
  updated?: string | undefined;
  bodyMarkdown?: string | undefined;
  bodyHtml?: string | undefined;
};
