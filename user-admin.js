#!/usr/bin/env node
// 账号管理 CLI（没有管理员可登录时的兜底手段，日常用网页里的「账号」页面即可）
// 用法：
//   node user-admin.js list
//   node user-admin.js add <账号> <密码> [--admin] [--name 显示名] [--sandbox read-only|workspace-write|danger-full-access] [--cwd /root]
//   node user-admin.js passwd <账号> <新密码>
//   node user-admin.js role <账号> admin|member
//   node user-admin.js enable|disable <账号>
//   node user-admin.js delete <账号>
// 注意：直接改的是 config.json，服务在运行中时请重启后生效（systemctl restart codex-web）。
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadSecretKey } from "./lib/secrets.js";
import { SANDBOX_LEVELS, hashPassword, loadConfig, normalizePermissions, persistConfig } from "./lib/store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = process.env.CODEX_WEB_CONFIG || path.join(__dirname, "config.json");
const DATA_DIR = process.env.CODEX_WEB_DATA_DIR || path.join(__dirname, "data");

const SECRET_KEY = loadSecretKey({ dataDir: DATA_DIR });
const cfg = loadConfig(CONFIG_PATH, { secretKey: SECRET_KEY });

function save(target) {
  for (const user of target.users) {
    user.permissions = normalizePermissions(user.permissions, user.role);
    delete user.password;
  }
  persistConfig(CONFIG_PATH, target);
}

function find(cfg, name) {
  const key = String(name || "").toLowerCase();
  return cfg.users.find((user) => user.username.toLowerCase() === key) || null;
}

function parseFlags(args) {
  const flags = {};
  for (let i = 0; i < args.length; i += 1) {
    if (!args[i].startsWith("--")) continue;
    const key = args[i].slice(2);
    if (key === "admin") flags.role = "admin";
    else flags[key] = args[i + 1] && !args[i + 1].startsWith("--") ? args[++i] : true;
  }
  return flags;
}

function usage() {
  console.log(`用法：
  node user-admin.js list
  node user-admin.js add <账号> <密码> [--admin] [--name 显示名] [--sandbox read-only|workspace-write|danger-full-access] [--cwd /root]
  node user-admin.js passwd <账号> <新密码>
  node user-admin.js role <账号> admin|member
  node user-admin.js enable|disable <账号>
  node user-admin.js delete <账号>`);
}

const [command, ...rest] = process.argv.slice(2);

switch (command) {
  case "list": {
    if (!cfg.users.length) console.log("（没有任何账号）");
    for (const user of cfg.users) {
      const perms = normalizePermissions(user.permissions, user.role);
      const state = user.disabled ? "已禁用" : "正常";
      console.log(
        `${user.username.padEnd(16)} ${user.role.padEnd(7)} ${state.padEnd(6)} 沙箱上限=${perms.sandboxMax.padEnd(18)} 目录=${perms.defaultCwd}`
      );
    }
    break;
  }
  case "add": {
    const [username, password] = rest;
    const flags = parseFlags(rest.slice(2));
    if (!username || !password) {
      usage();
      break;
    }
    if (!/^[A-Za-z0-9._-]{2,32}$/.test(username)) {
      console.error("账号需为 2-32 位字母、数字、点、下划线或短横线");
      process.exit(1);
    }
    if (password.length < 8) {
      console.error("密码至少 8 位");
      process.exit(1);
    }
    if (find(cfg, username)) {
      console.error(`账号 ${username} 已存在`);
      process.exit(1);
    }
    const role = flags.role === "admin" ? "admin" : "member";
    const permissions = normalizePermissions(
      {
        sandboxMax: SANDBOX_LEVELS.includes(flags.sandbox) ? flags.sandbox : undefined,
        defaultCwd: typeof flags.cwd === "string" ? flags.cwd : undefined,
      },
      role
    );
    cfg.users.push({
      username,
      displayName: typeof flags.name === "string" ? flags.name : "",
      passwordHash: hashPassword(password),
      role,
      disabled: false,
      sessionVersion: 0,
      createdAt: new Date().toISOString(),
      lastLoginAt: "",
      permissions,
    });
    save(cfg);
    console.log(`已创建账号 ${username}（${role}）`);
    break;
  }
  case "passwd": {
    const [username, password] = rest;
    const user = find(cfg, username);
    if (!user) {
      console.error(`账号 ${username} 不存在`);
      process.exit(1);
    }
    if (!password || password.length < 8) {
      console.error("密码至少 8 位");
      process.exit(1);
    }
    user.passwordHash = hashPassword(password);
    user.sessionVersion = Number(user.sessionVersion || 0) + 1;
    save(cfg);
    console.log(`已重置 ${username} 的密码（该账号其他登录已失效）`);
    break;
  }
  case "role": {
    const [username, role] = rest;
    const user = find(cfg, username);
    if (!user || !["admin", "member"].includes(role)) {
      if (!user) console.error(`账号 ${username} 不存在`);
      usage();
      break;
    }
    const otherAdmins = cfg.users.filter((u) => u !== user && u.role === "admin" && !u.disabled).length;
    if (role === "member" && otherAdmins === 0) {
      console.error("至少保留一个可用的管理员账号");
      process.exit(1);
    }
    user.role = role;
    save(cfg);
    console.log(`已将 ${username} 设为 ${role}`);
    break;
  }
  case "enable":
  case "disable": {
    const user = find(cfg, rest[0]);
    if (!user) {
      console.error(`账号 ${rest[0]} 不存在`);
      process.exit(1);
    }
    if (command === "disable" && user.role === "admin") {
      const otherAdmins = cfg.users.filter((u) => u !== user && u.role === "admin" && !u.disabled).length;
      if (otherAdmins === 0) {
        console.error("至少保留一个可用的管理员账号");
        process.exit(1);
      }
    }
    user.disabled = command === "disable";
    if (command === "disable") user.sessionVersion = Number(user.sessionVersion || 0) + 1;
    save(cfg);
    console.log(`已${command === "disable" ? "禁用" : "启用"} ${user.username}`);
    break;
  }
  case "delete": {
    const user = find(cfg, rest[0]);
    if (!user) {
      console.error(`账号 ${rest[0]} 不存在`);
      process.exit(1);
    }
    if (user.role === "admin" && cfg.users.filter((u) => u !== user && u.role === "admin" && !u.disabled).length === 0) {
      console.error("至少保留一个可用的管理员账号");
      process.exit(1);
    }
    cfg.users = cfg.users.filter((item) => item !== user);
    save(cfg);
    console.log(`已删除账号 ${user.username}`);
    break;
  }
  default:
    usage();
}
