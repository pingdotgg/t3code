#define _GNU_SOURCE

#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

static const char *pid_path;

static void *spawn_child(void *unused) {
    (void)unused;
    pid_t child = fork();
    if (child == 0) {
        execlp("sleep", "sleep", "120", NULL);
        _exit(127);
    }
    if (child < 0) return NULL;
    FILE *file = fopen(pid_path, "w");
    if (file != NULL) {
        fprintf(file, "%ld %d\n", syscall(SYS_gettid), child);
        fclose(file);
    }
    waitpid(child, NULL, 0);
    return NULL;
}

int main(int argc, char **argv) {
    if (argc != 2) return 2;
    pid_path = argv[1];
    pthread_t worker;
    if (pthread_create(&worker, NULL, spawn_child, NULL) != 0) return 3;
    if (pthread_join(worker, NULL) != 0) return 4;
    return 0;
}
