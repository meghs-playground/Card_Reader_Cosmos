/**
 * JWT authentication + role-based authorization.
 *   authenticate  -> verifies bearer token, attaches req.user
 *   authorize(...) -> restricts a route to the given roles
 */
const jwt = require("jsonwebtoken");

const SECRET = process.env.JWT_SECRET || "change-me-in-production";

function authenticate(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Missing token" });
  try {
    req.user = jwt.verify(token, SECRET);
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

function authorize(...roles) {
  return (req, res, next) => {
    if (!req.user || (roles.length && !roles.includes(req.user.role))) {
      return res.status(403).json({ error: "Forbidden" });
    }
    next();
  };
}

function signToken(user) {
  return jwt.sign(
    { sub: user.id, email: user.email, role: user.role, name: user.name },
    SECRET,
    { expiresIn: "12h" }
  );
}

module.exports = { authenticate, authorize, signToken };
