import { createRoot } from 'react-dom/client'
import moesifBrowser from "moesif-browser-js";
import './main.css'
import { SWRConfig } from 'swr'
import App from './App.jsx'
import "./styles/styles.scss";

createRoot(document.getElementById('root')).render(
  <SWRConfig
    value={{
      keepPreviousData: true,
      revalidateOnFocus: true,
      dedupingInterval: 5000,
      shouldRetryOnError: (error) =>
        !(error?.status === 401 || error?.sessionExpired),
    }}
  >
    <App />
  </SWRConfig>,
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
