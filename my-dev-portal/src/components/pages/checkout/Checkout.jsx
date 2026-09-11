import { Navigate, useSearchParams } from "react-router-dom";

// Existing bookmarks must not start a retired recurring subscription.
export default function Checkout() {
  const [params] = useSearchParams();
  const basic = ["basic_activation", "basic_credit_top_up"].includes(params.get("purchase_type"));
  return <Navigate replace to={basic ? "/credit" : "/plans"} />;
}
