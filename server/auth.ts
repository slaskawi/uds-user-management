import type { RequestHandler } from "express";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

const ADMIN_GROUP = "/UDS Core/Admin";

export function requireAdmin(options: {
  issuer: string;
  audience: string;
  jwksUri: string;
  requiredGroup?: string;
  getKey?: JWTVerifyGetKey;
}): RequestHandler {
  const getKey = options.getKey ?? createRemoteJWKSet(new URL(options.jwksUri));
  const requiredGroup = options.requiredGroup ?? ADMIN_GROUP;

  return async (req, res, next) => {
    const authorization = req.get("authorization");
    const token = authorization?.match(/^Bearer\s+(\S+)$/i)?.[1];
    if (!token) return res.status(401).json({ error: "unauthorized" });

    try {
      const { payload } = await jwtVerify(token, getKey, {
        issuer: options.issuer,
        audience: options.audience,
        algorithms: ["RS256"],
        requiredClaims: ["exp", "iat", "sub"],
      });
      const groups = payload.groups;
      if (!Array.isArray(groups) || !groups.includes(requiredGroup)) {
        return res.status(403).json({ error: "forbidden" });
      }
      next();
    } catch {
      res.status(401).json({ error: "unauthorized" });
    }
  };
}
