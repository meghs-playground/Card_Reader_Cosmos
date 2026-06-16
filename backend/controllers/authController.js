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
 * POST /api/auth/register
 * Body: { name, email, password }
 * Self-signup for employees. New accounts get the REVIEWER (employee) role and
 * can scan + see/download only their own leads. The seeded ADMIN is the
 * super-admin. Returns a token so the client is logged in immediately.
 */
async function register(req, res, next) {
  try {
    const { name, email, password, role, adminCode } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ error: "Name, email and password are required" });
    }
    if (String(password).length < 6) {
      return res.status(400).json({ error: "Password must be at least 6 characters" });
    }

    // Default role is employee (REVIEWER). Creating a SUPER ADMIN via signup
    // requires the ADMIN_SIGNUP_CODE so strangers can't grant themselves admin.
    let assignedRole = "REVIEWER";
    if (role === "ADMIN" || role === "super") {
      const expected = process.env.ADMIN_SIGNUP_CODE || "";
      if (!expected) {
        return res.status(403).json({
          error: "Super-admin signup is disabled. Ask an existing admin to promote your account, or set ADMIN_SIGNUP_CODE.",
        });
      }
      if (String(adminCode || "") !== expected) {
        return res.status(403).json({ error: "Invalid super-admin code." });
      }
      assignedRole = "ADMIN";
    }

    const normEmail = String(email).toLowerCase().trim();
    const existing = await prisma.user.findUnique({ where: { email: normEmail } });
    if (existing) {
      return res.status(409).json({ error: "An account with this email already exists" });
    }
    const passwordHash = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({
      data: { name: String(name).trim(), email: normEmail, passwordHash, role: assignedRole, isActive: true },
    });
    const token = signToken(user);
    audit(req, "AUTH_REGISTER", "User", user.id).catch(() => {});
    return res.status(201).json({
      token,
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
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

/**
 * POST /api/auth/change-password  (authenticated)
 * Body: { currentPassword, newPassword }. Any logged-in user changes their own.
 */
async function changePassword(req, res, next) {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: "Current and new password are required" });
    }
    if (String(newPassword).length < 6) {
      return res.status(400).json({ error: "New password must be at least 6 characters" });
    }
    const user = await prisma.user.findUnique({ where: { id: req.user.sub } });
    if (!user) return res.status(404).json({ error: "User not found" });
    const ok = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!ok) return res.status(401).json({ error: "Current password is incorrect" });
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: await bcrypt.hash(newPassword, 10) },
    });
    audit(req, "AUTH_PASSWORD_CHANGE", "User", user.id).catch(() => {});
    return res.json({ message: "Password updated" });
  } catch (e) {
    next(e);
  }
}

module.exports = { login, register, logout, me, changePassword };
