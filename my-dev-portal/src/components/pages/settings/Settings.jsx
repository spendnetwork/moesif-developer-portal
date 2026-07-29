import React from "react";
import Auth0Settings from "./Auth0Settings";

const openStripeManagement = (email) => {
  window.open(
    `${import.meta.env.REACT_APP_STRIPE_MANAGEMENT_URL}?prefilled_email=${email}`,
    "_blank",
    "noreferrer"
  );
};

const Settings = () => {
  return <Auth0Settings openStripeManagement={openStripeManagement} />;
};

export default Settings;
