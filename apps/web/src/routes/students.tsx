import { PlusIcon } from "lucide-react";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import type { Student } from "@t3tools/contracts";

import { Button } from "../components/ui/button";
import { SidebarInset, SidebarTrigger } from "../components/ui/sidebar";
import { isElectron } from "../env";
import { ensureLocalApi } from "../localApi";

function StudentsContentLayout() {
  const [students, setStudents] = useState<readonly Student[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const loadStudents = async () => {
      try {
        const localApi = ensureLocalApi();
        const loadedStudents = await localApi.persistence.getStudents();
        setStudents(loadedStudents);
      } catch (error) {
        console.error("Failed to load students:", error);
      } finally {
        setIsLoading(false);
      }
    };

    void loadStudents();
  }, []);

  const handleNewStudent = () => {
    // TODO: Show create form (will be implemented in later subtask)
    console.log("New student clicked");
  };

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        {!isElectron && (
          <header className="border-b border-border px-3 py-2 sm:px-5">
            <div className="flex min-h-7 items-center gap-2 sm:min-h-6">
              <SidebarTrigger className="size-7 shrink-0 md:hidden" />
              <span className="text-sm font-medium text-foreground">Students</span>
              <div className="ms-auto flex items-center gap-2">
                <Button size="xs" variant="outline" onClick={handleNewStudent}>
                  <PlusIcon className="mx-1 size-3.5" />
                  New Student
                </Button>
              </div>
            </div>
          </header>
        )}

        {isElectron && (
          <div className="drag-region flex h-[52px] shrink-0 items-center border-b border-border px-5 wco:h-[env(titlebar-area-height)] wco:pr-[calc(100vw-env(titlebar-area-width)-env(titlebar-area-x)+1em)]">
            <span className="text-xs font-medium tracking-wide text-muted-foreground/70">
              Students
            </span>
            <div className="ms-auto flex items-center gap-2">
              <Button size="xs" variant="outline" onClick={handleNewStudent}>
                <PlusIcon className="mx-1 size-3.5" />
                New Student
              </Button>
            </div>
          </div>
        )}

        <div className="min-h-0 flex flex-1">
          {/* Two-pane split layout */}
          <div className="flex min-h-0 flex-1">
            {/* Left pane: Student list */}
            <div className="border-r border-border w-80 min-h-0 flex flex-col">
              <div className="flex-1 overflow-y-auto p-4">
                {isLoading ? (
                  <div className="text-sm text-muted-foreground">Loading students...</div>
                ) : students.length === 0 ? (
                  <div className="flex flex-col items-center justify-center h-full gap-3">
                    <p className="text-sm text-muted-foreground">No students yet</p>
                    <Button size="sm" variant="outline" onClick={handleNewStudent}>
                      Add your first student
                    </Button>
                  </div>
                ) : (
                  <div className="space-y-1">
                    {students.map((student) => (
                      <div
                        key={student.id}
                        className="p-2 rounded hover:bg-accent cursor-pointer text-sm"
                      >
                        {student.name}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Right pane: Detail/Form (initially empty/welcome) */}
            <div className="flex-1 min-h-0 flex flex-col">
              <div className="flex-1 overflow-y-auto p-6">
                <div className="flex flex-col items-center justify-center h-full gap-3 text-center">
                  <p className="text-sm text-muted-foreground">
                    Select a student from the list to view details
                  </p>
                  <p className="text-xs text-muted-foreground/70">
                    or click "New Student" to add a new student
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </SidebarInset>
  );
}

function StudentsRouteLayout() {
  return <StudentsContentLayout />;
}

export const Route = createFileRoute("/students")({
  beforeLoad: async ({ context }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }
  },
  component: StudentsRouteLayout,
});
