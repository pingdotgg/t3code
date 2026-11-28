// Read all four identity fields from the same Darwin kernel snapshot.
#include <errno.h>
#include <stdint.h>
#include <stdlib.h>
#include <sys/sysctl.h>

typedef void (*identity_visitor)(void *, int, int, int, int64_t, const char *);

int t3_process_identities(void *context, identity_visitor visit) {
    int mib[] = {CTL_KERN, KERN_PROC, KERN_PROC_ALL};
    for (int attempt = 0; attempt < 3; attempt++) {
        size_t len = 0;
        if (sysctl(mib, 3, NULL, &len, NULL, 0) != 0) return -1;
        len += 32 * sizeof(struct kinfo_proc); // Allow for forks between the two calls.
        struct kinfo_proc *rows = malloc(len);
        if (!rows) return -1;
        if (sysctl(mib, 3, rows, &len, NULL, 0) == 0) {
            for (size_t i = 0; i < len / sizeof(*rows); i++) {
                struct kinfo_proc *row = &rows[i];
                if (row->kp_proc.p_pid <= 0) continue;
                row->kp_proc.p_comm[sizeof(row->kp_proc.p_comm) - 1] = '\0';
                const struct timeval start = row->kp_proc.p_starttime;
                visit(context, row->kp_proc.p_pid, row->kp_eproc.e_ppid, row->kp_eproc.e_pgid,
                      (int64_t)start.tv_sec * 1000000 + start.tv_usec, row->kp_proc.p_comm);
            }
            free(rows);
            return 0;
        }
        int error = errno;
        free(rows);
        if (error != ENOMEM) break;
    }
    return -1;
}
