const jwt = require("jsonwebtoken");
const jwksRsa = require("jwks-rsa");

// Verifies the idToken the developer portal sends as `Authorization: Bearer …`
// against Auth0's published signing keys.
//
// A 401 here is the portal's signal that the session is over: the frontend
// logs the user out and asks them to sign in again. Anything that is *not* an
// authentication problem must therefore avoid 401 (subscription checks in
// app.js use 403 for that reason).
const verifyTokenJWTPublicKey = async (req, res, next) => {
  const token = req.headers.authorization?.split(" ")[1]; // Extract Bearer token

  if (!token) {
    return res.status(401).json({ message: "Authorization token is required" });
  }

  const issuer = `https://${process.env.AUTH0_DOMAIN}/`;
  const jwksClient = jwksRsa({
    cache: true, // Enable caching
    rateLimit: true, // Prevent excessive requests
    jwksRequestsPerMinute: 10, // Limit requests per minute
    jwksUri: `https://${process.env.AUTH0_DOMAIN}/.well-known/jwks.json`,
  });

  try {
    const decodedHeader = jwt.decode(token, { complete: true });
    const kid = decodedHeader?.header?.kid;

    if (!kid) {
      return res.status(401).json({ message: "Invalid token" });
    }

    // Get the signing key from the JWKS
    const key = await jwksClient.getSigningKey(kid);
    const publicKey = key.getPublicKey(); // This is the public key used for verification

    // Verify the token
    const verifiedClaims = jwt.verify(token, publicKey, {
      algorithms: ["RS256"],
      issuer,
      audience: process.env.AUTH0_CLIENT_ID,
    });
    req.user = verifiedClaims;

    if (!verifiedClaims.email) {
      return res.status(401).json({
        message:
          "the jwt token provided do not have an email claim, are you using idToken? If using accessToken be sure to configure in your identify provider to add email in the claim.",
      });
    }

    // the sub is usually the user id in tokens.
    req.user.id = verifiedClaims.id || verifiedClaims.sub;
    next();
  } catch (err) {
    console.error("error from jwt verify", err);
    return res.status(401).json({ message: "Invalid token", error: err });
  }
};

const skipAuthCheck = (req, res, next) => {
  console.log(
    "skip authentication check in dev portal apis, enable by configuring AUTH0_DOMAIN in .env."
  );
  req.user = {};
  next();
};

function getFinalChecker() {
  if (!process.env.AUTH0_DOMAIN) {
    throw new Error(
      "AUTH0_DOMAIN must be provided in /my-dev-portal-api/.env to verify portal tokens"
    );
  }
  if (!process.env.AUTH0_CLIENT_ID) {
    throw new Error(
      "AUTH0_CLIENT_ID must be provided in /my-dev-portal-api/.env to validate portal ID tokens"
    );
  }
  return verifyTokenJWTPublicKey;
}

module.exports = {
  verifyTokenJWTPublicKey,
  skipAuthCheck,
  authMiddleware: getFinalChecker(),
};
