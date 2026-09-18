#!/usr/bin/env node
// Usage: node hash-password.js 'your-password'   ->  prints a scrypt hash for config.json
import crypto from "node:crypto";

const pass = String(process.argv[2] ?? "").trim();
if (!pass) {
  console.error("用法: node hash-password.js '<password>'");
  process.exit(1);
}

const salt = crypto.randomBytes(16);
const hash = crypto.scryptSync(pass, salt, 64);
console.log(`scrypt$${salt.toString("base64")}$${hash.toString("base64")}`);
