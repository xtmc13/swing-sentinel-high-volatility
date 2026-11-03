import type { MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";

const limitCredentialBody = bodyLimit({
  maxSize: 4 * 1024,
  onError: (c) => c.json({ error: "Credential request body too large" }, 413),
});

export function isCredentialMutationPath(path: string): boolean {
  if (!path.startsWith("/api/trpc/")) return false;
  return path.slice("/api/trpc/".length).split(",")
    .some((procedure) => procedure === "credentials.save" || procedure === "credentials.delete");
}

export const credentialBodyLimit: MiddlewareHandler = (c, next) => {
  if (!isCredentialMutationPath(c.req.path)) return next();
  return limitCredentialBody(c, next);
};
