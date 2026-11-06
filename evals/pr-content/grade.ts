export const gradePrContent = (generated: { title: string; body: string }) =>
  /retir|deprecat|legacy/i.test(generated.title) &&
  !/blocked|cannot access|can't start babysitting|restore GitHub|provide the PR number/i.test(
    `${generated.title}\n${generated.body}`,
  );
