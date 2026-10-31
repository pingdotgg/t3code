#include <dlfcn.h>
#include <errno.h>
#include <spawn.h>
#include <stdio.h>
#include <string.h>

extern char **environ;

/* macOS files every descendant under its responsible app, so a bundle-less
 * browser an agent starts checks in as T3 Code itself. Disclaiming here makes
 * the exec'd Helper responsible for its own tree. POSIX_SPAWN_SETEXEC replaces
 * this process, keeping the PID, open descriptors and signals the parent owns. */
typedef int (*setdisclaim_fn)(posix_spawnattr_t *, int);

static int exec_target(char *const argv[], int disclaim, const char **stage) {
    posix_spawnattr_t attr;
    int error = posix_spawnattr_init(&attr);
    if (error != 0) {
        *stage = "posix_spawnattr_init";
        return error;
    }
    error = posix_spawnattr_setflags(&attr, POSIX_SPAWN_SETEXEC);
    *stage = "posix_spawnattr_setflags";
    if (error == 0 && disclaim) {
        /* Private libSystem export without an SDK declaration; resolve it at
         * runtime so a macOS without it still starts the backend. */
        setdisclaim_fn setdisclaim =
            (setdisclaim_fn)dlsym(RTLD_DEFAULT, "responsibility_spawnattrs_setdisclaim");
        *stage = "responsibility_spawnattrs_setdisclaim";
        error = setdisclaim == NULL ? ENOSYS : setdisclaim(&attr, 1);
    }
    if (error == 0) {
        pid_t pid;
        *stage = "posix_spawn";
        error = posix_spawn(&pid, argv[0], NULL, &attr, argv, environ);
    }
    posix_spawnattr_destroy(&attr);
    return error;
}

/* Usage: t3-backend-launcher <executable> [arguments...]
 * Returns only when the executable cannot be started; stderr reaches the backend log. */
int main(int argc, char **argv) {
    if (argc < 2 || argv[1][0] != '/') {
        fprintf(stderr, "t3-backend-launcher: expected an absolute executable path\n");
        return 64;
    }
    const char *stage = "";
    int error = exec_target(argv + 1, 1, &stage);
    fprintf(stderr,
            "t3-backend-launcher: responsibility disclaim failed at %s (%s); "
            "starting the backend under T3 Code's responsibility\n",
            stage, strerror(error));
    error = exec_target(argv + 1, 0, &stage);
    fprintf(stderr, "t3-backend-launcher: could not start %s at %s (%s)\n", argv[1], stage,
            strerror(error));
    return 127;
}
