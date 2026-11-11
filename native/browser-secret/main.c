#include <libsecret/secret.h>
#include <stdio.h>
#include <string.h>

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

/* On KDE Chromium keeps its key in KWallet. A KWallet migration can leave a
 * stale duplicate visible through Secret Service, so ask KWallet itself, the
 * way Chromium's KWallet backend does, and get the item Chromium reads. */
static const char *const kwallet_entries[][3] = {
    {"chrome", "Chrome Keys", "Chrome Safe Storage"},
    {"chromium", "Chromium Keys", "Chromium Safe Storage"},
};
static const char kwallet_app[] = "T3 Code";

static GVariant *kwallet_call(GDBusConnection *bus, const char *method, GVariant *args,
                              const char *reply_type, gint timeout, GError **error) {
    return g_dbus_connection_call_sync(bus, "org.kde.kwalletd6", "/modules/kwalletd6",
                                       "org.kde.KWallet", method, args,
                                       G_VARIANT_TYPE(reply_type), G_DBUS_CALL_FLAGS_NONE, timeout,
                                       NULL, error);
}

static int read_kwallet(const char *folder, const char *entry) {
    GError *error = NULL;
    GDBusConnection *bus = g_bus_get_sync(G_BUS_TYPE_SESSION, NULL, &error);
    if (bus == NULL) {
        g_error_free(error);
        return KEY_MISSING;
    }
    int status = READ_FAILED;
    gboolean enabled = FALSE;
    gint32 handle = -1;
    GVariant *reply = kwallet_call(bus, "isEnabled", NULL, "(b)", -1, &error);
    if (reply != NULL) {
        g_variant_get(reply, "(b)", &enabled);
        g_variant_unref(reply);
        status = KEY_MISSING;
    }
    if (enabled && (reply = kwallet_call(bus, "networkWallet", NULL, "(s)", -1, &error))) {
        status = READ_FAILED;
        const gchar *wallet = NULL;
        g_variant_get(reply, "(&s)", &wallet);
        /* Opening a locked wallet shows KWallet's unlock prompt; cancelling returns -1. */
        GVariant *opened = kwallet_call(bus, "open",
                                        g_variant_new("(sxs)", wallet, (gint64)0, kwallet_app),
                                        "(i)", G_MAXINT, &error);
        g_variant_unref(reply);
        if (opened != NULL) {
            g_variant_get(opened, "(i)", &handle);
            g_variant_unref(opened);
            if (handle < 0) status = KEY_LOCKED;
        }
    }
    if (handle >= 0 &&
        (reply = kwallet_call(bus, "hasFolder", g_variant_new("(iss)", handle, folder, kwallet_app),
                              "(b)", -1, &error))) {
        gboolean has_folder = FALSE;
        g_variant_get(reply, "(b)", &has_folder);
        g_variant_unref(reply);
        status = KEY_MISSING;
        if (has_folder &&
            (reply = kwallet_call(bus, "readPassword",
                                  g_variant_new("(isss)", handle, folder, entry, kwallet_app),
                                  "(s)", -1, &error))) {
            const gchar *value = NULL;
            g_variant_get(reply, "(&s)", &value);
            size_t length = strlen(value);
            status = length == 0 ? KEY_MISSING : READ_FAILED;
            if (length > 0 && fwrite(value, 1, length, stdout) == length && fflush(stdout) == 0) {
                status = 0;
            }
            g_variant_unref(reply);
        }
    }
    if (handle >= 0) {
        reply = kwallet_call(bus, "close", g_variant_new("(ibs)", handle, FALSE, kwallet_app),
                             "(i)", -1, NULL);
        if (reply != NULL) g_variant_unref(reply);
    }
    if (error != NULL) {
        /* Without kwalletd6 there is no KWallet key to find. */
        if (g_error_matches(error, G_DBUS_ERROR, G_DBUS_ERROR_SERVICE_UNKNOWN) ||
            g_error_matches(error, G_DBUS_ERROR, G_DBUS_ERROR_NAME_HAS_NO_OWNER)) {
            status = KEY_MISSING;
        } else if (g_error_matches(error, G_DBUS_ERROR, G_DBUS_ERROR_ACCESS_DENIED)) {
            status = KEY_LOCKED;
        }
        g_error_free(error);
    }
    g_object_unref(bus);
    return status;
}

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
    for (gsize i = 0; status == KEY_MISSING && i < G_N_ELEMENTS(kwallet_entries); i++) {
        if (strcmp(argv[1], kwallet_entries[i][0]) == 0) {
            status = read_kwallet(kwallet_entries[i][1], kwallet_entries[i][2]);
        }
    }
    return status;
}
