const todayIso = (): string => new Date().toISOString().slice(0, 10);

export const markServiceProvisioned = (
  markdown: string,
  service: string,
  verifiedAt = todayIso(),
): string => {
  const lines = markdown.split("\n");
  const servicePattern = new RegExp(
    `^\\|\\s*${service.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\|`,
    "i",
  );
  let changed = false;

  const updated = lines.map((line) => {
    if (!servicePattern.test(line)) {
      return line;
    }

    const cells = line.split("|");
    if (cells.length < 5) {
      throw new Error(`Invalid Services table row for ${service}.`);
    }

    cells[3] = ` [x] provisioned (verified ${verifiedAt}) `;
    changed = true;
    return cells.join("|");
  });

  if (!changed) {
    throw new Error(`Service ${service} not found in docs/project.md Services table.`);
  }

  return updated.join("\n");
};
