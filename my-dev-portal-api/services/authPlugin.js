const jwt = require("jsonwebtoken");
const jwksRsa = require("jwks-rsa");

// The portal sends an Auth0 ID token as an Authorization Bearer token. A 401
// is reserved for an invalid or expired session; billing failures use other
// status codes so the frontend does not log out a valid user.
const auth0Domain = process.env.AUTH0_DOMAIN;
const auth0ClientId = process.env.AUTH0_CLIENT_ID;

if (!auth0Domain || !auth0ClientId) {
  throw new Error("AUTH0_DOMAIN and AUTH0_CLIENT_ID are required");
}

const issuer = `https://${auth0Domain}/`;
const jwksClient = jwksRsa({
  cache: true,
  rateLimit: true,
  jwksRequestsPerMinute: 10,
  jwksUri: `${issuer}.well-known/jwks.json`,
});

async function verifyTokenJWTPublicKey(req, res, next) {
  const authorization = req.headers.authorization || "";
  const token = authorization.match(/^Bearer ([^\s]+)$/)?.[1];
  if (!token) {
    return res.status(401).json({ message: "Authorization token is required" });
  }

  try {
    const decodedHeader = jwt.decode(token, { complete: true });
    const kid = decodedHeader?.header?.kid;
    if (!kid) {
      return res.status(401).json({ message: "Invalid token" });
    }

    const key = await jwksClient.getSigningKey(kid);
    const verifiedClaims = jwt.verify(token, key.getPublicKey(), {
      algorithms: ["RS256"],
      issuer,
      audience: auth0ClientId,
    });
    if (!verifiedClaims.sub || !verifiedClaims.email) {
      return res.status(401).json({
        message:
          "The authenticated identity does not include the required subject and email claims.",
      });
    }

    req.user = verifiedClaims;
    req.user.id = verifiedClaims.id || verifiedClaims.sub;
    return next();
  } catch (error) {
    console.warn("Auth0 token verification failed", {
      name: error?.name,
      message: error?.message,
    });
    return res.status(401).json({ message: "Invalid token" });
  }
}

module.exports = {
  verifyTokenJWTPublicKey,
  authMiddleware: verifyTokenJWTPublicKey,
};
