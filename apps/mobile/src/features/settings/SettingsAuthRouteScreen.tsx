import { useAuth } from "@clerk/expo";
import {
  AuthView,
  type UserProfileCustomPage,
  UserProfileView,
} from "@clerk/expo/native-components";
import { useNavigation } from "@react-navigation/native";
import { useEffect, useState } from "react";
import { View } from "react-native";

import { settlePromise, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { ScrollView } from "react-native";

import * as Dialog from "../../components/ui/Dialog";
import { useCloudAuth } from "../cloud/cloudAuth";
import { getMobileOidcController, signInWithBrowser } from "../cloud/oidc/mobileOidc";
import { cloudAuthProvider, hasCloudPublicConfig } from "../cloud/publicConfig";
import { T3ConnectProfilePage } from "../cloud/T3ConnectProfilePage";
import { SettingsRow } from "./components/SettingsRow";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";

const USER_PROFILE_CUSTOM_PAGES = [
  {
    path: "t3-connect",
    label: "T3 Connect",
    icon: "globe",
    content: <T3ConnectProfilePage />,
  },
] satisfies UserProfileCustomPage[];

// Without cloud config the app has no entry point here and appLinking drops the deep link.
export function SettingsAuthRouteScreen() {
  if (!hasCloudPublicConfig()) return null;
  return cloudAuthProvider() === "oidc" ? (
    <OidcSettingsAuthRouteScreen />
  ) : (
    <ConfiguredSettingsAuthRouteScreen />
  );
}

/** An OpenID Connect provider hosts no profile view, so this screen only signs in and out. */
function OidcSettingsAuthRouteScreen() {
  const { isSignedIn, accountLabel, signOut } = useCloudAuth();
  const [busy, setBusy] = useState(false);

  const signIn = async () => {
    const controller = getMobileOidcController();
    if (controller === null || busy) return;
    setBusy(true);
    const result = await settlePromise(() => signInWithBrowser(controller));
    setBusy(false);
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      Dialog.alert(
        "Could not sign in",
        error instanceof Error ? error.message : "The identity provider did not respond.",
      );
    }
  };

  return (
    <SettingsScreen title="T3 Account">
      <ScrollView contentContainerClassName="gap-6 px-5 pt-4">
        <SettingsSection>
          {isSignedIn ? (
            <SettingsRow
              icon="arrow.right.circle"
              label="Sign out"
              value={accountLabel ?? undefined}
              onPress={() => void signOut()}
            />
          ) : (
            <SettingsRow
              icon="person.crop.circle"
              label={busy ? "Opening sign-in…" : "Sign in"}
              disabled={busy}
              onPress={() => void signIn()}
            />
          )}
        </SettingsSection>
      </ScrollView>
    </SettingsScreen>
  );
}

function ConfiguredSettingsAuthRouteScreen() {
  const { isLoaded, isSignedIn } = useAuth({ treatPendingAsSignedOut: false });
  const navigation = useNavigation();
  const handleHostBack = () => navigation.goBack();
  // Once signed in, stay on the profile view so signing out pops back instead of
  // flashing the sign-in form.
  const [hasBeenSignedIn, setHasBeenSignedIn] = useState(isSignedIn === true);
  if (isSignedIn && !hasBeenSignedIn) setHasBeenSignedIn(true);

  // Clerk reports sign-out only through its auth store (the native profile view
  // and the T3 Connect page can both sign out), so this follows that store.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- pops the navigator when Clerk's auth store reports a sign-out from the profile view or Connect page
  useEffect(() => {
    if (hasBeenSignedIn && isLoaded && isSignedIn === false) {
      navigation.goBack();
    }
  }, [hasBeenSignedIn, isLoaded, isSignedIn, navigation]);

  return (
    <View collapsable={false} className="flex-1 overflow-hidden bg-sheet">
      {isLoaded ? (
        hasBeenSignedIn ? (
          <UserProfileView
            customPages={USER_PROFILE_CUSTOM_PAGES}
            isDismissible={false}
            onHostBack={handleHostBack}
          />
        ) : (
          <AuthView isDismissible={false} onHostBack={handleHostBack} />
        )
      ) : null}
    </View>
  );
}
