import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { useAuth } from "./store/auth";
import { setUnauthorizedHandler, setAccessToken } from "./lib/api";
import "./index.css";

// On session loss, drop the token and let the router redirect to sign-in.
setUnauthorizedHandler(() => setAccessToken(null));

function Root() {
  const { bootstrap } = useAuth();
  React.useEffect(() => {
    bootstrap();
  }, [bootstrap]);
  return <App />;
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
