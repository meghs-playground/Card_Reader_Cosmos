/**
 * Auth Controller
 * ---------------
 * POST /api/auth/login  — verifies email+password, returns JWT.
 * POST /api/auth/logout — stateless; client discards the token.
 * GET  /api/auth/me     — returns current user profile from token.
 */
const bcrypt = require("bcryptjs");
const prisma = require("../config/db");
const { signToken } = require("../middleware/auth");
const { audit } = require("../middleware/audit");

/**
 * POST /api/auth/login
 * Body: { email, password }
 */
async function login(req, res, next) {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: "Email and password are required" });
    }

    // Normalise email to lowercase for lookup.
    const user = await prisma.user.findUnique({
      where: { email: email.toLowerCase().trim() },
    });

    // Use a constant-time comparison via bcrypt even if user not found,
    // to prevent user-enumeration via timing differences.
    const dummyHash =
      "$2a$10$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ012345";
    const hash = user ? user.passwordHash : dummyHash;
    const valid = await bcrypt.compare(password, hash);

    if (!user || !valid) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    if (!user.isActive) {
      return res.status(403).json({ error: "Account is deactivated" });
    }

    const token = signToken(user);

    // Audit successful login (best-effort — don't fail login on audit error).
    audit(req, "AUTH_LOGIN", "User", user.id).catch(() => {});

    return res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
      },
    });
  } catch (e) {
    next(e);
  }
}

/**
 * POST /api/auth/logout
 * Stateless JWT — just acknowledge. Client must discard token.
 */
async function logout(req, res) {
  if (req.user) {
    audit(req, "AUTH_LOGOUT", "User", req.user.sub).catch(() => {});
  }
  return res.json({ message: "Logged out" });
}

/**
 * GET /api/auth/me
 * Returns the current user from the DB (token already verified by middleware).
 */
async function me(req, res, next) {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.sub },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        isActive: true,
        createdAt: true,
      },
    });
    if (!user) return res.status(404).json({ error: "User not found" });
    return res.json(user);
  } catch (e) {
    next(e);
  }
}

module.exports = { login, logout, me };
