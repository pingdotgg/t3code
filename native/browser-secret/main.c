#include <libsecret/secret.h>
#include <stdio.h>

/* Exit codes are consumed by ChromiumKeys.ts. Stdout contains only the secret,
 * with no newline or other framing that could change the derived cookie key. */
enum { KEY_MISSING = 2, KEY_LOCKED = 3, READ_FAILED = 4 };

/* Chromium looks its key up by attributes alone: items written by older
 * libgnome-keyring builds carry no schema name, and SECRET_SCHEMA_NONE would
 * refuse them. DONT_MATCH_NAME keeps the attribute match and drops the name. */
static const SecretSchema chromium_schema = {
    .name = "chrome_libsecret_os_crypt_password_v2",
    .flags = SECRET_SCHEMA_DONT_MATCH_NAME,
    .attributes = {{"application", SECRET_SCHEMA_ATTRIBUTE_STRING}, {NULL, 0}},
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
