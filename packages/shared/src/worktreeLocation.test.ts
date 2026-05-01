import { describe, expect, it } from "vitest";
import {
  createWorktreeLocationTemplateContext,
  getDefaultWorktreesDir,
  renderWorktreeLocationPreview,
  resolveCustomWorktreeLocationTemplate,
  resolveWorktreeLocation,
  substituteWorktreeLocationTemplate,
  validateWorktreeLocationTemplate,
} from "./worktreeLocation.ts";

describe("worktreeLocation helpers", () => {
  it("validates start-of-path and $WORKTREE_NAME requirements", () => {
    expect(validateWorktreeLocationTemplate("  ")).toBe("Enter a full path template.");
    expect(validateWorktreeLocationTemplate("$PROJECT_NAME/$WORKTREE_NAME")).toBe(
      "Custom worktree templates must start with $T3_HOME, $PROJECT_DIRNAME, /, or \\.",
    );
    expect(validateWorktreeLocationTemplate("$PROJECT_DIRNAME/custom")).toBe(
      "Custom worktree templates must include $WORKTREE_NAME.",
    );
    expect(validateWorktreeLocationTemplate("$PROJECT_DIRNAME/$WORKTREE_NAME")).toBeNull();
  });

  it("rejects absolute path variables outside the start of the template", () => {
    expect(validateWorktreeLocationTemplate("/custom/$T3_HOME/$WORKTREE_NAME")).toBe(
      "$T3_HOME and $PROJECT_DIRNAME can only appear at the start of the template.",
    );
    expect(
      validateWorktreeLocationTemplate("$PROJECT_DIRNAME/custom/$PROJECT_DIRNAME/$WORKTREE_NAME"),
    ).toBe("$T3_HOME and $PROJECT_DIRNAME can only appear at the start of the template.");
  });

  it("substitutes all supported variables", () => {
    const context = createWorktreeLocationTemplateContext({
      t3Home: "/home/dev/.t3",
      projectRoot: "/code/my-project",
      worktreeName: "feature-branch",
    });

    expect(
      substituteWorktreeLocationTemplate(
        "$T3_HOME|$PROJECT_DIRNAME|$PROJECT_NAME|$WORKTREE_NAME",
        context,
      ),
    ).toBe("/home/dev/.t3|/code|my-project|feature-branch");
  });

  it("resolves custom templates through one shared helper", () => {
    const context = createWorktreeLocationTemplateContext({
      t3Home: "~/.t3",
      projectRoot: "/code/my-project",
      worktreeName: "feature-branch",
    });

    expect(
      resolveCustomWorktreeLocationTemplate({
        template: "$PROJECT_DIRNAME/$PROJECT_NAME.$WORKTREE_NAME",
        context,
      }),
    ).toEqual({
      ok: true,
      path: "/code/my-project.feature-branch",
    });

    expect(
      resolveCustomWorktreeLocationTemplate({
        template: "$PROJECT_NAME/$WORKTREE_NAME",
        context,
      }),
    ).toEqual({
      ok: false,
      error: "Custom worktree templates must start with $T3_HOME, $PROJECT_DIRNAME, /, or \\.",
    });
  });

  it("resolves built-in and custom worktree modes through one shared helper", () => {
    const context = createWorktreeLocationTemplateContext({
      t3Home: "/home/dev/.t3",
      projectRoot: "/code/my-project",
      worktreeName: "feature-branch",
    });

    expect(
      resolveWorktreeLocation({
        mode: "default",
        template: "",
        context,
        defaultWorktreesDir: getDefaultWorktreesDir(context.$T3_HOME),
      }),
    ).toEqual({
      ok: true,
      path: "/home/dev/.t3/worktrees/my-project/feature-branch",
    });

    expect(
      resolveWorktreeLocation({
        mode: "project-subdirectory",
        template: "",
        context,
        defaultWorktreesDir: getDefaultWorktreesDir(context.$T3_HOME),
      }),
    ).toEqual({
      ok: true,
      path: "/code/my-project.worktrees/feature-branch",
    });

    expect(
      resolveWorktreeLocation({
        mode: "project-sibling",
        template: "",
        context,
        defaultWorktreesDir: getDefaultWorktreesDir(context.$T3_HOME),
      }),
    ).toEqual({
      ok: true,
      path: "/code/my-project.feature-branch",
    });

    expect(
      resolveWorktreeLocation({
        mode: "custom",
        template: "$PROJECT_DIRNAME/$PROJECT_NAME.worktrees/$WORKTREE_NAME",
        context,
        defaultWorktreesDir: getDefaultWorktreesDir(context.$T3_HOME),
      }),
    ).toEqual({
      ok: true,
      path: "/code/my-project.worktrees/feature-branch",
    });
  });

  it("requires a token boundary after absolute path variables at the start", () => {
    expect(validateWorktreeLocationTemplate("$T3_HOME_SUFFIX/$WORKTREE_NAME")).toBe(
      "Custom worktree templates must start with $T3_HOME, $PROJECT_DIRNAME, /, or \\.",
    );
    expect(validateWorktreeLocationTemplate("$PROJECT_DIRNAME_SUFFIX/$WORKTREE_NAME")).toBe(
      "Custom worktree templates must start with $T3_HOME, $PROJECT_DIRNAME, /, or \\.",
    );
  });

  it("rejects invalid custom previews", () => {
    const context = createWorktreeLocationTemplateContext({
      t3Home: "~/.t3",
      projectRoot: "/code/my-project",
      worktreeName: "feature-branch",
    });

    expect(
      renderWorktreeLocationPreview({
        mode: "custom",
        template: "  ",
        context,
      }),
    ).toEqual({
      preview: null,
      error: "Enter a full path template.",
    });
  });

  it("renders symbolic preview values for built-in and custom modes", () => {
    const context = createWorktreeLocationTemplateContext({
      t3Home: "~/.t3",
      projectRoot: "/code/my-project",
      worktreeName: "feature-branch",
    });

    expect(
      renderWorktreeLocationPreview({
        mode: "default",
        template: "",
        context,
      }),
    ).toEqual({
      preview: "~/.t3/worktrees/my-project/feature-branch",
      error: null,
    });

    expect(
      renderWorktreeLocationPreview({
        mode: "project-subdirectory",
        template: "",
        context,
      }),
    ).toEqual({
      preview: "/code/my-project.worktrees/feature-branch",
      error: null,
    });

    expect(
      renderWorktreeLocationPreview({
        mode: "project-sibling",
        template: "",
        context,
      }),
    ).toEqual({
      preview: "/code/my-project.feature-branch",
      error: null,
    });

    expect(
      renderWorktreeLocationPreview({
        mode: "custom",
        template: "$PROJECT_DIRNAME/$PROJECT_NAME.$WORKTREE_NAME",
        context,
      }),
    ).toEqual({
      preview: "/code/my-project.feature-branch",
      error: null,
    });
  });
});
