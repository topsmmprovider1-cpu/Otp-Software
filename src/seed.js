const bcrypt = require('bcryptjs');
const config = require('./config');
const db = require('./db');

async function seedAdmin() {
  const email = String(config.adminEmail).trim().toLowerCase();
  const existing = await db.getUserByEmail(email);
  if (existing) {
    if (existing.role !== 'admin') {
      await db.updateUser(existing.id, { role: 'admin', isActive: true });
      console.log(`[seed] Admin role restored for ${email}`);
    }
    return existing;
  }
  const hash = await bcrypt.hash(String(config.adminPassword), 10);
  await db.createUser({
    fullName: 'Administrator',
    email,
    phone: '',
    passwordHash: hash,
    role: 'admin',
    balance: 0,
  });
  console.log(`[seed] Admin created -> email: ${email}  password: ${config.adminPassword}`);
}

module.exports = { seedAdmin };