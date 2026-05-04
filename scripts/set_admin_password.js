#!/usr/bin/env node
// Usage: node scripts/set_admin_password.js "<MONGODB_URI>" "newPassword"

const { MongoClient } = require('mongodb');
const bcrypt = require('bcrypt');

async function main() {
  const [,, uri, newPassword] = process.argv;
  if (!uri || !newPassword) {
    console.error('Usage: node scripts/set_admin_password.js "<MONGODB_URI>" "newPassword"');
    process.exit(2);
  }

  const client = new MongoClient(uri, { useNewUrlParser: true, useUnifiedTopology: true });
  try {
    await client.connect();
    const db = client.db();
    const users = db.collection('users');

    const passwordHash = await bcrypt.hash(newPassword, 10);

    const res = await users.updateOne(
      { username: 'admin' },
      { $set: { password_hash: passwordHash, password_seed_version: 9999 } },
      { upsert: true }
    );

    if (res.matchedCount) {
      console.log('Admin password updated successfully.');
    } else if (res.upsertedCount) {
      console.log('Admin user created with new password.');
    } else {
      console.log('Operation completed.');
    }
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  } finally {
    await client.close();
  }
}

main();
