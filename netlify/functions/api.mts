import serverless from "serverless-http";
import { app } from "../../server/src/app.js";

export const handler = serverless(app, {
  request: (request, event) => {
    const eventPath = typeof event.path === "string" ? event.path : "";
    const functionPrefix = "/.netlify/functions/api";
    if (eventPath.startsWith(functionPrefix)) {
      const routePath = eventPath.slice(functionPrefix.length);
      request.url = `/api${routePath.startsWith("/") ? routePath : `/${routePath}`}`;
    }
  },
});
