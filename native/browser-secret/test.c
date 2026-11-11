/* Replaces only the keyring calls at link time. The executable under test uses
 * the real libsecret schema/values and GLib ownership, without a desktop bus. */
#include <libsecret/secret.h>
#include <string.h>

static const char *scenario;

/* KWallet, through Secret Service, stores the key as server=<folder>,
 * user=<entry> with no application attribute. Pairs follow Chromium's
 * freedesktop_secret_key_provider.h branding. */
static const char *const kwallet_items[][3] = {
    {"chrome", "Chrome Keys", "Chrome Safe Storage"},
    {"chromium", "Chromium Keys", "Chromium Safe Storage"},
};

static SecretItem *kwallet_item(const char *value) {
    SecretItem *item = g_object_new(SECRET_TYPE_ITEM, NULL);
    g_object_set_data(G_OBJECT(item), "value", (gpointer)value);
    return item;
}

/* Chrome's wallet keeps a stale migrated item beside its current key, with
 * identical attributes; Chromium's has only its current key. */
static GList *search_kwallet(GHashTable *attributes, SecretSearchFlags flags) {
    g_assert_cmpint(flags, ==, SECRET_SEARCH_ALL | SECRET_SEARCH_UNLOCK | SECRET_SEARCH_LOAD_SECRETS);
    const char *server = g_hash_table_lookup(attributes, "server");
    const char *user = g_hash_table_lookup(attributes, "user");
    for (gsize i = 0; i < G_N_ELEMENTS(kwallet_items); i++) {
        if (g_strcmp0(server, kwallet_items[i][1]) == 0 && g_strcmp0(user, kwallet_items[i][2]) == 0) {
            scenario = "kwallet";
            GList *items = g_list_append(NULL, kwallet_item("live \xc3\xa9\xe2\x82\xac"));
            return i == 0 ? g_list_prepend(items, kwallet_item("stale")) : items;
        }
    }
    return NULL;
}

GList *__wrap_secret_service_search_sync(SecretService *service, const SecretSchema *schema,
                                       GHashTable *attributes, SecretSearchFlags flags,
                                       GCancellable *cancellable, GError **error) {
    if (!g_hash_table_contains(attributes, "application")) return search_kwallet(attributes, flags);
    g_assert_null(service);
    g_assert_null(cancellable);
    g_assert_cmpstr(schema->name, ==, "chrome_libsecret_os_crypt_password_v2");
    g_assert_cmpint(schema->flags, ==, SECRET_SCHEMA_DONT_MATCH_NAME);
    g_assert_cmpint(flags, ==, SECRET_SEARCH_UNLOCK | SECRET_SEARCH_LOAD_SECRETS);
    g_assert_cmpuint(g_hash_table_size(attributes), ==, 1);
    scenario = g_intern_string(g_hash_table_lookup(attributes, "application"));
    if (strcmp(scenario, "missing") == 0) return NULL;
    for (gsize i = 0; i < G_N_ELEMENTS(kwallet_items); i++) {
        if (strcmp(scenario, kwallet_items[i][0]) == 0) return NULL;
    }
    if (strcmp(scenario, "cancelled") == 0) {
        g_set_error_literal(error, G_IO_ERROR, G_IO_ERROR_CANCELLED, "cancelled");
        return NULL;
    }
    if (strcmp(scenario, "denied") == 0) {
        g_set_error_literal(error, G_DBUS_ERROR, G_DBUS_ERROR_ACCESS_DENIED, "denied");
        return NULL;
    }
    if (strcmp(scenario, "unavailable") == 0) {
        g_set_error_literal(error, G_IO_ERROR, G_IO_ERROR_CONNECTION_CLOSED, "unavailable");
        return NULL;
    }
    return g_list_append(NULL, g_object_new(SECRET_TYPE_ITEM, NULL));
}

gboolean __wrap_secret_item_get_locked(SecretItem *item) {
    g_assert_true(SECRET_IS_ITEM(item));
    return strcmp(scenario, "locked") == 0;
}

SecretValue *__wrap_secret_item_get_secret(SecretItem *item) {
    g_assert_true(SECRET_IS_ITEM(item));
    const char *kwallet_value = g_object_get_data(G_OBJECT(item), "value");
    if (kwallet_value != NULL) return secret_value_new(kwallet_value, -1, "text/plain");
    if (strcmp(scenario, "unloaded") == 0) return NULL;
    if (strcmp(scenario, "empty") == 0) return secret_value_new("", 0, "text/plain");
    const char value[] = "secret\0with whitespace \t\r\n";
    return secret_value_new(value, sizeof(value) - 1, "application/octet-stream");
}
