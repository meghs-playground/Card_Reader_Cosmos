/**
 * Seed: creates an initial admin user so you can log in immediately.
 * Run: `node prisma/seed.js`  (after migrate)
 * Change ADMIN_PASSWORD before running in any shared environment.
 */
const bcrypt = require("bcryptjs");
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

async function main() {
  const email = process.env.ADMIN_EMAIL || "admin@cosmos.local";
  const password = process.env.ADMIN_PASSWORD || "ChangeMe!123";
  const passwordHash = await bcrypt.hash(password, 10);

  await prisma.user.upsert({
    where: { email },
    update: { passwordHash },
    create: { email, name: "Cosmos Admin", role: "ADMIN", passwordHash },
  });
  console.log(`Seeded admin: ${email}`);
}

main().finally(() => prisma.$disconnect());
