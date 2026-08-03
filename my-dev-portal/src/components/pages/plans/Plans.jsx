import React, { useEffect } from "react";

import PlansView from "./PlansView";

function Plans() {
  useEffect(() => {
    window?.moesif?.track("viewed-plans-page");
  }, []);
  return <PlansView />;
}

export default Plans;
