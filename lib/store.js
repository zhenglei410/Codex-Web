// config.json 的读写与规范化。server.js / user-admin.js / model-admin.js 共用同一套逻辑，
// 避免命令行工具和网页端各自维护一份配置结构而互相覆盖字段。
import fs from "node:fs";
import crypto from "node:crypto";
import { encryptSecret, maskSecret, isEncrypted } from "./secrets.js";

// 沙箱等级：数值越大权限越高
export const SANDBOX_RANK = { "read-only": 0, "workspace-write": 1, "danger-full-access": 2 };
export const SANDBOX_LEVELS = Object.keys(SANDBOX_RANK);
export const WIRE_APIS = ["responses", "chat"];

// 默认的「本机权限控制」策略。默认值刻意保守：不限制工作目录，但拦住明显危险的命令，
// 并保护系统关键路径不被 Codex 改写。
export const DEFAULT_DENY_COMMANDS = [
  "rm\\s+-[a-zA-Z]*r[a-zA-Z]*f?\\s+/(\\s|$)",
  "rm\\s+-[a-zA-Z]*f[a-zA-Z]*r?\\s+/(\\s|$)",
  "mkfs(\\.[a-z0-9]+)?\\b",
  "\\bdd\\b[^\\n]*of=/dev/(sd|nvme|vd|hd)",
  ">\\s*/dev/(sd|nvme|vd|hd)[a-z0-9]",
  "\\b(shutdown|reboot|halt|poweroff)\\b",
  ":\\s*\\(\\s*\\)\\s*\\{.*\\}\\s*;?\\s*:",
  "\\bchmod\\s+-R\\s+777\\s+/(\\s|$)",
];

export const DEFAULT_PROTECT_PATHS = [
  "/etc",
  "/boot",
  "/dev",
  "/proc",
  "/sys",
  "/root/.ssh",
  "/root/.codex",
  "/root/.gnupg",
];

// 新账号的默认权限（管理员角色会被强制放开全部权限）
export function defaultPermissions() {
  return {
    run: true,
    browse: false,
    threads: true,
    threadsAll: false,
    manageUsers: false,
    sandboxMax: "workspace-write",
    defaultCwd: "/root",
  };
}

export function normalizePermissions(input, role) {
  const base = defaultPermissions();
  const raw = input && typeof input === "object" ? input : {};
  const perms = {
    run: raw.run === undefined ? base.run : Boolean(raw.run),
    browse: Boolean(raw.browse),
    threads: raw.threads === undefined ? base.threads : Boolean(raw.threads),
    threadsAll: Boolean(raw.threadsAll),
    manageUsers: Boolean(raw.manageUsers),
    sandboxMax: SANDBOX_RANK[raw.sandboxMax] === undefined ? base.sandboxMax : raw.sandboxMax,
    defaultCwd:
      typeof raw.defaultCwd === "string" && raw.defaultCwd.trim() ? raw.defaultCwd.trim() : base.defaultCwd,
  };
  if (role === "admin") {
    perms.run = true;
    perms.browse = true;
    perms.threads = true;
    perms.threadsAll = true;
    perms.manageUsers = true;
    perms.sandboxMax = "danger-full-access";
  }
  return perms;
}

export function defaultPolicy() {
  return {
    enabled: true,
    allowedRoots: [],
    browseRoots: [],
    denyCommands: [...DEFAULT_DENY_COMMANDS],
    protectPaths: [...DEFAULT_PROTECT_PATHS],
    maxRunMinutes: 0,
    allowNetwork: true,
    audit: true,
  };
}

function stringList(value, fallback = []) {
  if (!Array.isArray(value)) return [...fallback];
  return value
    .map((item) => String(item ?? "").trim())
    .filter(Boolean)
    .slice(0, 200);
}

export function normalizePolicy(input) {
  const base = defaultPolicy();
  const raw = input && typeof input === "object" ? input : {};
  const minutes = Number(raw.maxRunMinutes);
  return {
    enabled: raw.enabled === undefined ? base.enabled : Boolean(raw.enabled),
    allowedRoots: stringList(raw.allowedRoots, base.allowedRoots),
    browseRoots: stringList(raw.browseRoots, base.browseRoots),
    denyCommands: stringList(raw.denyCommands, base.denyCommands),
    protectPaths: stringList(raw.protectPaths, base.protectPaths),
    maxRunMinutes: Number.isFinite(minutes) && minutes > 0 ? Math.min(Math.round(minutes), 24 * 60) : 0,
    allowNetwork: raw.allowNetwork === undefined ? base.allowNetwork : Boolean(raw.allowNetwork),
    audit: raw.audit === undefined ? base.audit : Boolean(raw.audit),
  };
}

export function normalizeProviderId(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .slice(0, 40);
}

function defaultEnvKey(id) {
  return `${String(id || "provider").toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;
}

/**
 * 规范化单个模型供应商。
 * 输入里的 `apiKey` 是明文（只可能来自网页表单或命令行），这里立刻加密成 `apiKeyEnc`，
 * 并同时算出脱敏显示值 `apiKeyMask`；规范化的结果里不再包含任何明文字段。
 */
export function normalizeProvider(raw, { secretKey } = {}) {
  const input = raw && typeof raw === "object" ? raw : {};
  const id = normalizeProviderId(input.id || input.name);
  if (!id) return null;
  const models = stringList(input.models).map((item) => item.replace(/[\s"']/g, ""));
  const provider = {
    id,
    name: String(input.name || id).trim().slice(0, 60) || id,
    baseUrl: String(input.baseUrl || "").trim().replace(/\/+$/, "") ? String(input.baseUrl || "").trim() : "",
    wireApi: WIRE_APIS.includes(input.wireApi) ? input.wireApi : "responses",
    envKey: String(input.envKey || "").trim() || defaultEnvKey(id),
    apiKeyEnc: isEncrypted(input.apiKeyEnc) ? input.apiKeyEnc : "",
    apiKeyMask: String(input.apiKeyMask || "").trim(),
    models: models.slice(0, 100),
    defaultModel: String(input.defaultModel || "").trim().slice(0, 120),
    modelCatalog: String(input.modelCatalog || "").trim().slice(0, 400),
    reasoningEffort: ["", "minimal", "low", "medium", "high", "max"].includes(input.reasoningEffort)
      ? String(input.reasoningEffort || "")
      : "",
    createdAt: input.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  if (!provider.defaultModel && provider.models.length) provider.defaultModel = provider.models[0];

  const plaintext = typeof input.apiKey === "string" ? input.apiKey.trim() : "";
  if (plaintext) {
    if (!secretKey) throw new Error("缺少加密密钥，无法保存 API Key");
    provider.apiKeyEnc = encryptSecret(plaintext, secretKey);
    provider.apiKeyMask = maskSecret(plaintext);
  } else if (!provider.apiKeyEnc) {
    // 没有存量密文时清空脱敏显示，避免出现「有提示但实际没保存」的假象
    if (input.apiKey === "") provider.apiKeyMask = "";
  }
  if (provider.apiKeyEnc && !provider.apiKeyMask) provider.apiKeyMask = "已保存（加密）";
  return provider;
}

// 模型中心：active 是默认供应商，providers 是全部供应商
export function normalizeModels(input, { secretKey } = {}) {
  const raw = input && typeof input === "object" ? input : {};
  const list = Array.isArray(raw.providers) ? raw.providers : [];
  const providers = [];
  for (const item of list) {
    const provider = normalizeProvider(item, { secretKey });
    if (!provider) continue;
    if (providers.some((existing) => existing.id === provider.id)) continue;
    providers.push(provider);
  }
  const active = normalizeProviderId(raw.active);
  return {
    active: providers.some((provider) => provider.id === active) ? active : providers[0]?.id || "",
    providers,
  };
}

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64);
  return `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
}

function baseDefaults() {
  return {
    host: "127.0.0.1",
    port: 8790,
    users: [],
    sessionSecret: "",
    sessionTtlHours: 72,
    codexBin: "/root/.local/bin/codex",
    codexHome: "/root/.codex",
    defaultCwd: "/root",
    sandbox: "danger-full-access",
    model: "",
    maxConcurrentRuns: 3,
    maxConcurrentRunsPerUser: 2,
    models: { active: "", providers: [] },
    policy: defaultPolicy(),
  };
}

export function normalizeUserRecord(raw, state = {}) {
  const role = raw.role === "admin" ? "admin" : "member";
  const user = {
    username: String(raw.username || "").trim(),
    displayName: String(raw.displayName || "").trim(),
    passwordHash: String(raw.passwordHash || ""),
    password: String(raw.password || ""),
    role,
    disabled: Boolean(raw.disabled),
    sessionVersion: Number.isFinite(Number(raw.sessionVersion)) ? Number(raw.sessionVersion) : 0,
    createdAt: raw.createdAt || new Date().toISOString(),
    lastLoginAt: raw.lastLoginAt || "",
    // true = 下次登录必须先改密码（首次部署的默认账号、管理员重置密码后都会带上）
    mustChangePassword: Boolean(raw.mustChangePassword),
    permissions: normalizePermissions(raw.permissions, role),
  };
  // 旧的明文密码只在内存里兼容一次，随即转成哈希，避免再次落盘明文
  if (!user.passwordHash && user.password) {
    user.passwordHash = hashPassword(user.password);
    user.password = "";
    state.needsSave = true;
  }
  return user;
}

/**
 * 读取并规范化配置。发现旧结构（单账号、明文密码、明文 API Key）时会立刻写回，
 * 因此在配置文件被人工编辑过之后，第一次启动就会自动完成加密与迁移。
 */
export function loadConfig(configPath, { secretKey } = {}) {
  const state = { needsSave: false };
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (err) {
    console.error(`[codex-web] 无法读取配置 ${configPath}: ${err.message}`);
  }
  const merged = { ...baseDefaults(), ...raw };
  // 旧版配置没有 models / policy 两段，启动时补齐并写回，便于管理员直接照着文件改
  if (!raw.models || !raw.policy) state.needsSave = true;
  if (!merged.sessionSecret) {
    merged.sessionSecret = crypto.randomBytes(32).toString("hex");
    state.needsSave = true;
    console.error("[codex-web] config.json 缺少 sessionSecret，已生成随机值并写回");
  }

  // 兼容旧版单账号配置：username / passwordHash 迁移成 users[0]（管理员）
  const list = Array.isArray(merged.users) ? merged.users.filter((item) => item && item.username) : [];
  if (!list.length && (raw.username || raw.passwordHash || raw.password)) {
    list.push({
      username: String(raw.username || "admin"),
      displayName: "",
      passwordHash: raw.passwordHash || "",
      password: raw.password || "",
      role: "admin",
      disabled: false,
      sessionVersion: 0,
      createdAt: new Date().toISOString(),
      permissions: defaultPermissions(),
    });
    state.needsSave = true;
    console.error("[codex-web] 检测到旧版单账号配置，已迁移为多账号（admin 为管理员）");
  }
  merged.users = list.map((item) => normalizeUserRecord(item, state));
  if (!merged.users.length) {
    console.error("[codex-web] 警告：未配置任何账号，登录将始终失败（可用 node user-admin.js add <账号> <密码> --admin 创建）");
  }

  // 模型供应商：明文 apiKey 自动加密
  const rawProviders = Array.isArray(raw.models?.providers) ? raw.models.providers : [];
  if (rawProviders.some((item) => item && (item.apiKey || (item.apiKeyEnc && !item.apiKeyMask)))) {
    state.needsSave = true;
  }
  merged.models = normalizeModels(merged.models, { secretKey });
  if (!merged.models.providers.length) merged.models.active = "";

  merged.policy = normalizePolicy(merged.policy);
  delete merged.username;
  delete merged.passwordHash;
  delete merged.password;

  if (state.needsSave) {
    try {
      persistConfig(configPath, merged);
      console.log(`[codex-web] 配置已规范化并写回 ${configPath}`);
    } catch (err) {
      console.error(`[codex-web] 配置写回失败: ${err.message}`);
    }
  }
  return merged;
}

// 只把已知字段写回磁盘，并对供应商做去敏处理（永远不会写出明文 apiKey）
export function persistConfig(configPath, cfg) {
  const out = {
    host: cfg.host,
    port: cfg.port,
    users: (cfg.users || []).map((user) => ({
      username: user.username,
      displayName: user.displayName || "",
      passwordHash: user.passwordHash || "",
      role: user.role,
      disabled: Boolean(user.disabled),
      sessionVersion: Number(user.sessionVersion || 0),
      createdAt: user.createdAt || "",
      lastLoginAt: user.lastLoginAt || "",
      mustChangePassword: Boolean(user.mustChangePassword),
      permissions: normalizePermissions(user.permissions, user.role),
    })),
    sessionSecret: cfg.sessionSecret,
    sessionTtlHours: cfg.sessionTtlHours,
    codexBin: cfg.codexBin,
    codexHome: cfg.codexHome,
    defaultCwd: cfg.defaultCwd,
    sandbox: cfg.sandbox,
    model: cfg.model,
    maxConcurrentRuns: cfg.maxConcurrentRuns,
    maxConcurrentRunsPerUser: cfg.maxConcurrentRunsPerUser,
    models: {
      active: normalizeProviderId(cfg.models?.active),
      providers: (cfg.models?.providers || [])
        .filter((provider) => provider && provider.id)
        .map((provider) => ({
          id: normalizeProviderId(provider.id),
          name: provider.name || provider.id,
          baseUrl: provider.baseUrl || "",
          wireApi: WIRE_APIS.includes(provider.wireApi) ? provider.wireApi : "responses",
          envKey: provider.envKey || defaultEnvKey(provider.id),
          apiKeyEnc: isEncrypted(provider.apiKeyEnc) ? provider.apiKeyEnc : "",
          apiKeyMask: provider.apiKeyMask || "",
          models: Array.isArray(provider.models) ? provider.models : [],
          defaultModel: provider.defaultModel || "",
          modelCatalog: provider.modelCatalog || "",
          reasoningEffort: provider.reasoningEffort || "",
          createdAt: provider.createdAt || "",
          updatedAt: provider.updatedAt || "",
        })),
    },
    policy: normalizePolicy(cfg.policy),
  };
  fs.writeFileSync(configPath, `${JSON.stringify(out, null, 2)}\n`, { mode: 0o600 });
  // 文件已存在时 writeFileSync 不会改权限，这里显式收紧（配置里有密码哈希与 API Key 密文）
  try {
    fs.chmodSync(configPath, 0o600);
  } catch {
    /* 忽略：某些文件系统不支持 */
  }
  return out;
}
