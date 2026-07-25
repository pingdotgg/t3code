/**
 * ProjectKind - Derives the project kind from its workspace root.
 *
 * The reserved "Chats" pseudo-project lives at `<baseDir>/chats` and hosts
 * one-off conversations that are not tied to a real codebase. The kind is
 * derived at read time (never persisted) so it stays correct across base-dir
 * moves and pre-existing rows.
 *
 * @module ProjectKind
 */
import type { ProjectKind } from "@t3tools/contracts";

export const resolveProjectKind = (
  workspaceRoot: string,
  chatsDir: string | undefined,
): ProjectKind => (chatsDir !== undefined && workspaceRoot === chatsDir ? "chats" : "standard");
