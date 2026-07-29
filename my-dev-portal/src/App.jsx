import { BrowserRouter, Routes, Route } from "react-router-dom";

import Dashboard from "./components/pages/dashboard/Dashboard";
import Settings from "./components/pages/settings/Settings";
import { Auth0ProviderWithNavigate } from "./Auth0ProviderWithNavigate";
import Keys from "./components/pages/keys/Keys";
import { AuthenticationGuard } from "./components/authentication-guard";
import Return from "./components/pages/checkout/Return";
import Plans from "./components/pages/plans/Plans";
import Home from "./components/pages/home/Home";
import Checkout from "./components/pages/checkout/Checkout";
import Subscription from "./components/pages/subscription/Subscription";
import Welcome from "./components/pages/welcome/Welcome";
import { PageFooter } from "./components/page-footer";
import SessionTimeout from "./components/session-timeout";

function App() {
  return (
    <div>
      <div>
        <BrowserRouter>
          <Auth0ProviderWithNavigate>
            <SessionTimeout />
            <Routes>
              {/* Home redirects signed-in users to /dashboard itself. The
                  redirect can't live here: App sits above Auth0Provider, so a
                  useAuth0() call at this level would always read the default
                  (unauthenticated) context. */}
              <Route path="/" element={<Home />} />
              <Route path="/plans" element={<Plans />} />
              <Route
                path="/checkout"
                element={<AuthenticationGuard component={Checkout} />}
              />
              <Route
                path="/return"
                element={<AuthenticationGuard component={Return} />}
              />
              <Route
                path="dashboard"
                element={<AuthenticationGuard component={Dashboard} />}
              />
              <Route
                path="settings"
                element={<AuthenticationGuard component={Settings} />}
              />
              <Route
                path="keys"
                element={<AuthenticationGuard component={Keys} />}
              />
              <Route
                path="welcome"
                element={<AuthenticationGuard component={Welcome} />}
              />
              <Route
                path="subscription"
                element={<AuthenticationGuard component={Subscription} />}
              />
            </Routes>
          </Auth0ProviderWithNavigate>
        </BrowserRouter>
      </div>
      <PageFooter />
    </div>
  );
}

export default App;
