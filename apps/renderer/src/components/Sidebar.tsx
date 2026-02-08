import { useState } from "react";
import { useStore } from "../store";
import type { Project } from "../types";

function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export default function Sidebar() {
  const { state, dispatch } = useStore();
  const [addingProject, setAddingProject] = useState(false);
  const [newCwd, setNewCwd] = useState("");
  const [newModel, setNewModel] = useState("gpt-5.1-codex");

  const handleAddProject = () => {
    const cwd = newCwd.trim();
    if (!cwd) return;
    const name = cwd.split("/").filter(Boolean).pop() ?? "project";
    const project: Project = {
      id: crypto.randomUUID(),
      name,
      cwd,
      model: newModel.trim() || "gpt-5.1-codex",
      expanded: true,
    };
    dispatch({ type: "ADD_PROJECT", project });
    setNewCwd("");
    setNewModel("gpt-5.1-codex");
    setAddingProject(false);
  };

  const handleNewThread = (projectId: string) => {
    dispatch({
      type: "ADD_THREAD",
      thread: {
        id: crypto.randomUUID(),
        projectId,
        title: "New thread",
        session: null,
        messages: [],
        events: [],
        error: null,
        createdAt: new Date().toISOString(),
      },
    });
  };

  return (
    <aside className="sidebar flex h-full w-[260px] shrink-0 flex-col border-r border-white/[0.08] bg-[#141414]">
      {/* Branding */}
      <div className="flex items-center gap-2 px-4 pt-5 pb-4">
        <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-white text-xs font-bold text-[#0c0c0c]">
          CT
        </div>
        <span className="text-sm font-semibold tracking-tight text-[#e0e0e0]">
          CodeThing
        </span>
      </div>

      {/* New thread (global) */}
      <div className="px-3 pb-3">
        <button
          type="button"
          className="flex w-full items-center gap-2 rounded-lg border border-white/[0.08] bg-white/[0.04] px-3 py-2 text-xs text-[#a0a0a0]/80 transition-colors duration-150 hover:bg-white/[0.07]"
          onClick={() => {
            if (state.projects.length === 0) {
              setAddingProject(true);
              return;
            }
            const firstProject = state.projects[0];
            if (firstProject) handleNewThread(firstProject.id);
          }}
        >
          <span className="text-white">+</span>
          New thread
        </button>
      </div>

      {/* Project list */}
      <nav className="flex-1 overflow-y-auto px-2">
        {state.projects.map((project) => {
          const threads = state.threads.filter(
            (t) => t.projectId === project.id,
          );
          return (
            <div key={project.id} className="mb-1">
              {/* Project header */}
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors duration-150 hover:bg-white/[0.05]"
                onClick={() =>
                  dispatch({ type: "TOGGLE_PROJECT", projectId: project.id })
                }
              >
                <span className="text-[10px] text-[#a0a0a0]/50">
                  {project.expanded ? "▼" : "▶"}
                </span>
                <span className="flex-1 truncate text-xs font-medium text-[#e0e0e0]/90">
                  {project.name}
                </span>
                <span className="text-[10px] text-[#a0a0a0]/40">
                  {threads.length}
                </span>
              </button>

              {/* Threads */}
              {project.expanded && (
                <div className="ml-2 border-l border-white/[0.06] pl-2">
                  {threads.map((thread) => {
                    const isActive = state.activeThreadId === thread.id;
                    return (
                      <button
                        key={thread.id}
                        type="button"
                        className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors duration-150 ${
                          isActive
                            ? "bg-white/10 text-white"
                            : "text-[#a0a0a0]/70 hover:bg-white/[0.04]"
                        }`}
                        onClick={() =>
                          dispatch({
                            type: "SET_ACTIVE_THREAD",
                            threadId: thread.id,
                          })
                        }
                      >
                        <span className="flex-1 truncate text-xs">
                          {thread.title}
                        </span>
                        <span className="shrink-0 text-[10px] text-[#a0a0a0]/30">
                          {formatRelativeTime(thread.createdAt)}
                        </span>
                      </button>
                    );
                  })}

                  {/* New thread within project */}
                  <button
                    type="button"
                    className="flex w-full items-center gap-1 px-2 py-1 text-[10px] text-[#a0a0a0]/40 transition-colors duration-150 hover:text-[#a0a0a0]/60"
                    onClick={() => handleNewThread(project.id)}
                  >
                    <span>+</span> New thread
                  </button>
                </div>
              )}
            </div>
          );
        })}

        {state.projects.length === 0 && !addingProject && (
          <div className="px-2 pt-4 text-center text-xs text-[#a0a0a0]/40">
            No projects yet.
            <br />
            Add one to get started.
          </div>
        )}
      </nav>

      {/* Add project form */}
      {addingProject ? (
        <div className="border-t border-white/[0.08] p-3">
          <p className="mb-2 text-[10px] font-medium uppercase tracking-wider text-[#a0a0a0]/50">
            Add project
          </p>
          <input
            className="mb-2 w-full rounded-md border border-white/[0.1] bg-white/[0.04] px-2 py-1.5 font-mono text-xs text-[#e0e0e0] placeholder:text-[#a0a0a0]/30 focus:border-white/30 focus:outline-none"
            placeholder="/path/to/project"
            value={newCwd}
            onChange={(e) => setNewCwd(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleAddProject();
              if (e.key === "Escape") setAddingProject(false);
            }}
          />
          <input
            className="mb-2 w-full rounded-md border border-white/[0.1] bg-white/[0.04] px-2 py-1.5 font-mono text-xs text-[#e0e0e0] placeholder:text-[#a0a0a0]/30 focus:border-white/30 focus:outline-none"
            placeholder="model (default: gpt-5.1-codex)"
            value={newModel}
            onChange={(e) => setNewModel(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleAddProject();
              if (e.key === "Escape") setAddingProject(false);
            }}
          />
          <div className="flex gap-2">
            <button
              type="button"
              className="flex-1 rounded-md bg-white px-2 py-1 text-xs font-medium text-[#0c0c0c] transition-colors duration-150 hover:bg-white/90"
              onClick={handleAddProject}
            >
              Add
            </button>
            <button
              type="button"
              className="flex-1 rounded-md border border-white/[0.1] px-2 py-1 text-xs text-[#a0a0a0]/60 transition-colors duration-150 hover:bg-white/[0.04]"
              onClick={() => setAddingProject(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="border-t border-white/[0.08] p-3">
          <button
            type="button"
            className="flex w-full items-center justify-center gap-1 rounded-md border border-dashed border-white/[0.12] py-2 text-xs text-[#a0a0a0]/50 transition-colors duration-150 hover:border-white/[0.2] hover:text-[#a0a0a0]/70"
            onClick={() => setAddingProject(true)}
          >
            + Add project
          </button>
        </div>
      )}
    </aside>
  );
}
