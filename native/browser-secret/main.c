#include <libsecret/secret.h>
#include <stdio.h>
#include <string.h>

/* Exit codes are consumed by ChromiumKeys.ts. Stdout contains only the secret,
 * with no newline or other framing that could change the derived cookie key. */
/* KEY_CANDIDATES: stdout holds several secrets, each followed by a NUL byte. */
enum { KEY_MISSING = 2, KEY_LOCKED = 3, READ_FAILED = 4, KEY_CANDIDATES = 5 };

/* Chromium looks its key up by attributes alone: items written by older
 * libgnome-keyring builds carry no schema name, and SECRET_SCHEMA_NONE would
 * refuse them. DONT_MATCH_NAME keeps the attribute match and drops the name. */
static const SecretSchema chromium_schema = {
    .name = "chrome_libsecret_os_crypt_password_v2",
    .flags = SECRET_SCHEMA_DONT_MATCH_NAME,
    .attributes = {{"application", SECRET_SCHEMA_ATTRIBUTE_STRING}, {NULL, 0}},
};

/* On KDE Chromium writes the key through KWallet, which ksecretd exposes as
 * server=<folder>, user=<entry> with no application attribute. A KWallet
 * migration can leave a stale item with identical attributes, and nothing in
 * the wallet tells the two apart, so every match is returned for the caller to
 * try against the cookies. Pairs follow Chromium's KWallet branding. */
static const SecretSchema kwallet_schema = {
    .name = "org.qt.keychain",
    .flags = SECRET_SCHEMA_DONT_MATCH_NAME,
    .attributes = {{"server", SECRET_SCHEMA_ATTRIBUTE_STRING},
                   {"user", SECRET_SCHEMA_ATTRIBUTE_STRING},
                   {NULL, 0}},
};
static const char *const kwallet_entries[][3] = {
    {"chrome", "Chrome Keys", "Chrome Safe Storage"},
    {"chromium", "Chromium Keys", "Chromium Safe Storage"},
};

int main(int argc, char **argv) {
    if (argc != 2 || argv[1][0] == '\0') return 64;
    g_set_application_name("T3 Code");

    GHashTable *attributes = secret_attributes_build(&chromium_schema, "application", argv[1], NULL);
    GError *error = NULL;
    /* libsecret keeps the normal desktop unlock prompt. A cancelled unlock can
     * still return a locked item, so check the item before reading its value. */
    GList *items = secret_service_search_sync(
        NULL, &chromium_schema, attributes,
        SECRET_SEARCH_UNLOCK | SECRET_SEARCH_LOAD_SECRETS, NULL, &error);
    g_hash_table_unref(attributes);
    for (gsize i = 0; error == NULL && items == NULL && i < G_N_ELEMENTS(kwallet_entries); i++) {
        if (strcmp(argv[1], kwallet_entries[i][0]) != 0) continue;
        attributes = secret_attributes_build(&kwallet_schema, "server", kwallet_entries[i][1],
                                             "user", kwallet_entries[i][2], NULL);
        items = secret_service_search_sync(
            NULL, &kwallet_schema, attributes,
            SECRET_SEARCH_ALL | SECRET_SEARCH_UNLOCK | SECRET_SEARCH_LOAD_SECRETS, NULL, &error);
        g_hash_table_unref(attributes);
    }

    int status = READ_FAILED;
    if (error != NULL) {
        if (g_error_matches(error, G_IO_ERROR, G_IO_ERROR_CANCELLED) ||
            g_error_matches(error, G_IO_ERROR, G_IO_ERROR_PERMISSION_DENIED) ||
            g_error_matches(error, G_DBUS_ERROR, G_DBUS_ERROR_ACCESS_DENIED) ||
            g_error_matches(error, SECRET_ERROR, SECRET_ERROR_IS_LOCKED)) {
            status = KEY_LOCKED;
        }
        g_error_free(error);
    } else if (items == NULL) {
        status = KEY_MISSING;
    } else if (items->next != NULL) {
        status = KEY_MISSING;
        for (GList *link = items; link != NULL; link = link->next) {
            if (secret_item_get_locked(link->data)) {
                status = KEY_LOCKED;
                break;
            }
            SecretValue *secret = secret_item_get_secret(link->data);
            if (secret == NULL) continue;
            gsize length = 0;
            const gchar *value = secret_value_get(secret, &length);
            /* KWallet passwords are text, so a NUL byte cannot appear inside one. */
            if (length > 0 && memchr(value, '\0', length) == NULL) {
                status = fwrite(value, 1, length, stdout) == length && fputc('\0', stdout) != EOF
                             ? KEY_CANDIDATES
                             : READ_FAILED;
            }
            secret_value_unref(secret);
            if (status == READ_FAILED) break;
        }
        if (status == KEY_CANDIDATES && fflush(stdout) != 0) status = READ_FAILED;
    } else {
        SecretItem *item = SECRET_ITEM(items->data);
        if (secret_item_get_locked(item)) {
            status = KEY_LOCKED;
        } else {
            SecretValue *secret = secret_item_get_secret(item);
            if (secret != NULL) {
                gsize length = 0;
                const gchar *value = secret_value_get(secret, &length);
                status = length == 0 ? KEY_MISSING : READ_FAILED;
                if (length > 0 && fwrite(value, 1, length, stdout) == length && fflush(stdout) == 0) {
                    status = 0;
                }
                secret_value_unref(secret);
            }
        }
    }
    g_list_free_full(items, g_object_unref);
    return status;
}
