/* eslint-disable react-refresh/only-export-components -- Isolated preview mock; never imported by the production app. */
const user = { sub: "auth0|fixture", email: "developer@example.test", name: "Portal preview" };
export const Auth0Provider = ({ children }) => children;
export const withAuthenticationRequired = (component) => component;
export const useAuth0 = () => ({ isAuthenticated: true, isLoading: false, user, logout: () => {}, loginWithRedirect: () => {} });
