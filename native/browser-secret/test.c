/* Replaces only the keyring calls at link time. The executable under test uses
 * the real libsecret schema/values and GLib ownership, without a desktop bus. */
#include <libsecret/secret.h>
#include <string.h>

static const char *scenario;

GList *__wrap_secret_service_search_sync(SecretService *service, const SecretSchema *schema,
                                       GHashTable *attributes, SecretSearchFlags flags,
                                       GCancellable *cancellable, GError **error) {
    g_assert_null(service);
    g_assert_null(cancellable);
    g_assert_cmpstr(schema->name, ==, "chrome_libsecret_os_crypt_password_v2");
    g_assert_cmpint(schema->flags, ==, SECRET_SCHEMA_DONT_MATCH_NAME);
    g_assert_cmpint(flags, ==, SECRET_SEARCH_UNLOCK | SECRET_SEARCH_LOAD_SECRETS);
    g_assert_cmpuint(g_hash_table_size(attributes), ==, 1);
    scenario = g_intern_string(g_hash_table_lookup(attributes, "application"));
    if (strcmp(scenario, "missing") == 0 || strcmp(scenario, "chrome") == 0 ||
        strcmp(scenario, "chromium") == 0) {
        return NULL;
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
    if (strcmp(scenario, "unloaded") == 0) return NULL;
    if (strcmp(scenario, "empty") == 0) return secret_value_new("", 0, "text/plain");
    const char value[] = "secret\0with whitespace \t\r\n";
    return secret_value_new(value, sizeof(value) - 1, "application/octet-stream");
}

/* Stands in for kwalletd6. T3_TEST_KWALLET picks its state; unset is a wallet
 * holding both browsers' keys. */
GDBusConnection *__wrap_g_bus_get_sync(GBusType type, GCancellable *cancellable, GError **error) {
    g_assert_cmpint(type, ==, G_BUS_TYPE_SESSION);
    g_assert_null(cancellable);
    g_assert_nonnull(error);
    return (GDBusConnection *)g_object_new(G_TYPE_OBJECT, NULL);
}

GVariant *__wrap_g_dbus_connection_call_sync(GDBusConnection *bus, const gchar *name,
                                             const gchar *path, const gchar *interface,
                                             const gchar *method, GVariant *args,
                                             const GVariantType *reply_type, GDBusCallFlags flags,
                                             gint timeout, GCancellable *cancellable,
                                             GError **error) {
    g_assert_nonnull(bus);
    g_assert_cmpstr(name, ==, "org.kde.kwalletd6");
    g_assert_cmpstr(path, ==, "/modules/kwalletd6");
    g_assert_cmpstr(interface, ==, "org.kde.KWallet");
    g_assert_cmpint(flags, ==, G_DBUS_CALL_FLAGS_NONE);
    g_assert_null(cancellable);
    const char *wallet = g_getenv("T3_TEST_KWALLET");
    if (wallet == NULL) wallet = "";
    if (args != NULL) g_variant_ref_sink(args);
    GVariant *reply = NULL;
    if (strcmp(wallet, "absent") == 0) {
        g_set_error_literal(error, G_DBUS_ERROR, G_DBUS_ERROR_SERVICE_UNKNOWN, "absent");
    } else if (strcmp(method, "isEnabled") == 0) {
        reply = g_variant_new("(b)", strcmp(wallet, "disabled") != 0);
    } else if (strcmp(method, "networkWallet") == 0) {
        reply = g_variant_new("(s)", "kdewallet");
    } else if (strcmp(method, "open") == 0) {
        const gchar *opened = NULL;
        gint64 window = -1;
        g_variant_get(args, "(&sx&s)", &opened, &window, NULL);
        g_assert_cmpstr(opened, ==, "kdewallet");
        g_assert_cmpint(window, ==, 0);
        g_assert_cmpint(timeout, ==, G_MAXINT);
        reply = g_variant_new("(i)", strcmp(wallet, "cancelled") == 0 ? -1 : 7);
    } else if (strcmp(method, "hasFolder") == 0) {
        gint32 handle = -1;
        const gchar *folder = NULL;
        g_variant_get(args, "(i&s&s)", &handle, &folder, NULL);
        g_assert_cmpint(handle, ==, 7);
        reply = g_variant_new("(b)", strcmp(wallet, "no-folder") != 0);
    } else if (strcmp(method, "readPassword") == 0) {
        gint32 handle = -1;
        const gchar *folder = NULL, *entry = NULL;
        g_variant_get(args, "(i&s&s&s)", &handle, &folder, &entry, NULL);
        g_assert_cmpint(handle, ==, 7);
        const char *value = "";
        if (strcmp(folder, "Chrome Keys") == 0 && strcmp(entry, "Chrome Safe Storage") == 0) {
            value = "chrome \xc3\xa9\xe2\x82\xac";
        } else if (strcmp(folder, "Chromium Keys") == 0 &&
                   strcmp(entry, "Chromium Safe Storage") == 0) {
            value = "chromium \xc3\xa9\xe2\x82\xac";
        }
        reply = g_variant_new("(s)", value);
    } else {
        g_assert_cmpstr(method, ==, "close");
        reply = g_variant_new("(i)", 0);
    }
    if (args != NULL) g_variant_unref(args);
    if (reply != NULL) g_assert_true(g_variant_is_of_type(reply, reply_type));
    return reply;
}
