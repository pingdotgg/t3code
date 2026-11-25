import { expect, it } from "vite-plus/test";
import { readOmpSkills } from "./skills.ts";

it("projects manually invoked and ordinary OMP skills without leaking discovery warnings", () => {
  const skills = readOmpSkills(
    JSON.stringify({
      skills: [
        {
          name: "review",
          description: "Review the working tree",
          filePath: "/project/.omp/skills/review/SKILL.md",
          source: "native:project",
          hide: false,
        },
        {
          name: "release",
          description: "Prepare a release",
          filePath: "/user/.omp/skills/release/SKILL.md",
          source: "native:user",
          hide: true,
        },
      ],
      warnings: [{ skillPath: "/unrelated", message: "Skipped an invalid skill" }],
    }),
  );
  expect(skills).toEqual([
    {
      name: "review",
      description: "Review the working tree",
      path: "/project/.omp/skills/review/SKILL.md",
      scope: "project",
      enabled: true,
    },
    {
      name: "release",
      description: "Prepare a release",
      path: "/user/.omp/skills/release/SKILL.md",
      scope: "user",
      enabled: true,
      userInvocationOnly: true,
    },
  ]);
});

it("distinguishes an empty catalog from an invalid CLI response", () => {
  expect(readOmpSkills('{"skills":[]}')).toEqual([]);
  expect(readOmpSkills('{"error":"filesystem unavailable"}')).toBeUndefined();
});
