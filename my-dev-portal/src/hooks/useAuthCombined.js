import { useState, useEffect } from "react";
import { useAuth0 } from "@auth0/auth0-react";
import { moesifIdentifyUserFrontEndIfPossible } from "../common/utils";
import { notifySessionExpired } from "../lib/session-expiry";

// Auth0 errors that mean the underlying session is gone, so a silent token
// refresh can never succeed. Without treating these as an expiry the app sits
// on a permanent loading spinner: pages wait for an idToken that will never
// arrive.
const AUTH0_SESSION_DEAD = [
  "login_required",
  "consent_required",
  "interaction_required",
  "invalid_grant",
  "missing_refresh_token",
];

function isSessionDeadError(err) {
  return AUTH0_SESSION_DEAD.includes(err?.error);
}

// Single place to read the current user, the raw idToken sent to the portal
// API, and the access token. Kept as one hook (rather than pages calling
// useAuth0 directly) because it also owns the token-refresh failure handling
// below.
export default function useAuthCombined() {
  const {
    user: auth0User,
    isLoading: auth0IsLoading,
    isAuthenticated,
    loginWithRedirect,
    getAccessTokenSilently,
    getIdTokenClaims,
    ...rest
  } = useAuth0();

  let isLoading = auth0IsLoading;
  let user = auth0User;

  const [idToken, setIdToken] = useState();
  const [accessToken, setAccessToken] = useState();

  const handleSignUp = async ({ returnTo }) => {
    await loginWithRedirect({
      appState: {
        returnTo: returnTo || "/product-select",
      },
      authorizationParams: {
        prompt: "login",
        screen_hint: "signup",
      },
      scope: "openid profile email offline_access",
    });
  };

  useEffect(() => {
    if (isAuthenticated) {
      getAccessTokenSilently()
        .then((result) => {
          setAccessToken(result);
        })
        .catch((err) => {
          console.error("failed to load access token", err);
          if (isSessionDeadError(err)) notifySessionExpired();
        });

      getIdTokenClaims()
        .then((result) => {
          // No claims means Auth0 has no usable session left for this user.
          if (!result?.__raw) {
            notifySessionExpired();
            return;
          }
          const idToken = result.__raw;
          // https://github.com/auth0/auth0-react/issues/262
          setIdToken(idToken);
          moesifIdentifyUserFrontEndIfPossible(idToken);
        })
        .catch((err) => {
          console.error("failed to load id token", err);
          if (isSessionDeadError(err)) notifySessionExpired();
        });
    }
  }, [isAuthenticated, getAccessTokenSilently, getIdTokenClaims]);

  return {
    isAuthenticated,
    user,
    isLoading,
    handleSignUp,
    idToken,
    accessToken,
    userEmail: auth0User?.email,
    ...rest,
  };
}
