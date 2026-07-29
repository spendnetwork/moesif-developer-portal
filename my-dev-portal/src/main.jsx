import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import moesifBrowser from "moesif-browser-js";
import './main.css'
import { SWRConfig } from 'swr'
import App from './App.jsx'
import "https://js.stripe.com/v3/pricing-table.js";
import "./styles/styles.scss";

createRoot(document.getElementById('root')).render(
  // <StrictMode>
    <SWRConfig
      value={{
        keepPreviousData: true,
        revalidateOnFocus: true,
        dedupingInterval: 5000,
        // Never retry an expired/rejected token: the session is over and the
        // app is already logging the user out, so retries would only hammer
        // the API from behind a redirect. Everything else keeps SWR's default
        // backoff.
        shouldRetryOnError: (error) =>
          !(error?.status === 401 || error?.sessionExpired),
      }}
    >
      <App />
    </SWRConfig>
  // </StrictMode>,
)

if (import.meta.env.REACT_APP_MOESIF_PUBLISHABLE_APPLICATION_ID) {
  moesifBrowser.init({
    applicationId: import.meta.env.REACT_APP_MOESIF_PUBLISHABLE_APPLICATION_ID,
    // add other option here
  });
  if (window) {
    window.moesif = moesifBrowser;
  }
} else {
  console.log(
    "Please add using REACT_APP_MOESIF_PUBLISHABLE_APPLICATION_ID to .env to enable Moesif Browser JS to track actions such as sign up"
  );
}
