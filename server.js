#!/usr/bin/env node
// Codex Web — a ChatGPT-desktop-style web client that drives the local Codex CLI.
// Zero runtime dependencies; requires only Node.js >= 20 and the codex binary.
import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadSecretKey, decryptSecret } from "./lib/secrets.js";
import {
  SANDBOX_RANK,
  WIRE_APIS,
  defaultPolicy,
  hashPassword as hashPasswordValue,
  loadConfig as loadConfigFile,
  normalizePermissions,
  normalizePolicy,
  normalizeProvider,
  normalizeProviderId,
  normalizeUserRecord,
  persistConfig as persistConfigFile,
} from "./lib/store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = process.env.CODEX_WEB_CONFIG || path.join(__dirname, "config.json");
const PUBLIC_DIR = path.join(__dirname, "public");
// 运行期数据（会话归属、审计日志、API Key 加密密钥）都放在这里
const DATA_DIR = process.env.CODEX_WEB_DATA_DIR || path.join(__dirname, "data");

// API Key 的加密主密钥：默认来自 data/secrets.key，可用 CODEX_WEB_SECRET_KEY 覆盖
const SECRET_KEY = loadSecretKey({ dataDir: DATA_DIR });
const cfg = loadConfigFile(CONFIG_PATH, { secretKey: SECRET_KEY });

function persistConfig(source = cfg) {
  return persistConfigFile(CONFIG_PATH, source);
}

const hashPassword = (password) => hashPasswordValue(password);

// ---------------------------------------------------------------- accounts

function findUser(name) {
  const key = String(name || "").trim().toLowerCase();
  if (!key) return null;
  return cfg.users.find((item) => item.username.toLowerCase() === key) || null;
}

function publicUser(user) {
  return {
    username: user.username,
    displayName: user.displayName || "",
    role: user.role,
    disabled: Boolean(user.disabled),
    createdAt: user.createdAt || "",
    lastLoginAt: user.lastLoginAt || "",
    mustChangePassword: Boolean(user.mustChangePassword),
    permissions: normalizePermissions(user.permissions, user.role),
  };
}

// 除 except 之外，还有几个「可用的管理员」
function otherEnabledAdmins(except) {
  return cfg.users.filter((item) => item !== except && item.role === "admin" && !item.disabled).length;
}

// ---------------------------------------------------------------- helpers

const safeEqual = (a, b) => {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
};

const hmac = (payload) =>
  crypto.createHmac("sha256", cfg.sessionSecret).update(payload).digest("base64url");

function makeToken(username) {
  const user = findUser(username);
  const payload = Buffer.from(
    JSON.stringify({
      u: username,
      sv: Number(user?.sessionVersion || 0),
      exp: Date.now() + cfg.sessionTtlHours * 3600_000,
    })
  ).toString("base64url");
  return `${payload}.${hmac(payload)}`;
}

function verifyToken(token) {
  if (!token || typeof token !== "string") return null;
  const idx = token.lastIndexOf(".");
  if (idx <= 0) return null;
  const payload = token.slice(0, idx);
  const sig = token.slice(idx + 1);
  if (!safeEqual(sig, hmac(payload))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!data.exp || data.exp < Date.now()) return null;
    const user = findUser(data.u);
    if (!user || user.disabled) return null;
    // sessionVersion 变化即视为该账号的旧登录全部失效
    if (Number(data.sv || 0) !== Number(user.sessionVersion || 0)) return null;
    return { u: user.username, user };
  } catch {
    return null;
  }
}

// 校验成功返回账号记录，失败返回 null
function verifyCredentials(username, password) {
  const user = findUser(username);
  if (!user || user.disabled) {
    // 账号不存在/被禁用时也走一次 scrypt，避免用响应时间探测账号是否存在
    crypto.scryptSync(String(password), Buffer.alloc(16), 64);
    return null;
  }
  if (user.passwordHash) {
    const [algo, salt, hash] = String(user.passwordHash).split("$");
    if (algo !== "scrypt" || !salt || !hash) return null;
    const calc = crypto.scryptSync(String(password), Buffer.from(salt, "base64"), 64).toString("base64");
    return safeEqual(calc, hash) ? user : null;
  }
  if (user.password) return safeEqual(password, user.password) ? user : null;
  return null;
}

// ---------------------------------------------------------------- login throttling

const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_MAX_FAILURES = 8;
const loginAttempts = new Map(); // ip -> { failures, first, blockedUntil }

function clientIp(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return String(req.headers["x-real-ip"] || forwarded || req.socket.remoteAddress || "unknown").trim();
}

function loginBlockSeconds(ip) {
  const record = loginAttempts.get(ip);
  if (!record) return 0;
  if (record.blockedUntil && record.blockedUntil > Date.now()) {
    return Math.ceil((record.blockedUntil - Date.now()) / 1000);
  }
  if (Date.now() - record.first > LOGIN_WINDOW_MS) {
    loginAttempts.delete(ip);
  }
  return 0;
}

function recordLoginFailure(ip) {
  const now = Date.now();
  const record = loginAttempts.get(ip) || { failures: 0, first: now, blockedUntil: 0 };
  if (now - record.first > LOGIN_WINDOW_MS) {
    record.failures = 0;
    record.first = now;
  }
  record.failures += 1;
  if (record.failures >= LOGIN_MAX_FAILURES) {
    record.blockedUntil = now + LOGIN_WINDOW_MS;
    record.failures = 0;
    record.first = now;
  }
  loginAttempts.set(ip, record);
}

function sessionCookie(token, req) {
  const secure = req.headers["x-forwarded-proto"] === "https" ? " Secure;" : "";
  return `codex_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax;${secure} Max-Age=${
    cfg.sessionTtlHours * 3600
  }`;
}

function parseCookies(header = "") {
  const out = {};
  for (const part of String(header).split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function currentUser(req) {
  return verifyToken(parseCookies(req.headers.cookie).codex_session);
}

// 需要「管理账号」权限：未登录返回 401，权限不足返回 403
function requireManage(req, res) {
  const actor = currentUser(req);
  if (!actor) {
    sendJSON(res, 401, { error: "unauthorized" });
    return null;
  }
  if (!actor.user.permissions.manageUsers) {
    sendJSON(res, 403, { error: "当前账号没有管理账号的权限" });
    return null;
  }
  return actor;
}

function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

async function readBody(req, limit = 2 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("payload too large");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(text);
  } catch {
    return { prompt: text };
  }
}

// ---------------------------------------------------------------- thread ownership

// Codex 的会话记录在磁盘上是全局共享的，这里额外记录「哪个会话由哪个账号发起」，
// 让普通成员默认只能看到自己的会话，管理员可看全部。
const THREAD_OWNERS_PATH = path.join(DATA_DIR, "thread-owners.json");
let threadOwners = {};
try {
  const parsed = JSON.parse(fs.readFileSync(THREAD_OWNERS_PATH, "utf8"));
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) threadOwners = parsed;
} catch {
  /* 首次运行时还没有归属文件 */
}

function recordThreadOwner(threadId, username) {
  if (!threadId || !username) return;
  if (threadOwners[threadId] === username) return;
  threadOwners[threadId] = username;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(THREAD_OWNERS_PATH, `${JSON.stringify(threadOwners, null, 2)}\n`, { mode: 0o600 });
  } catch (err) {
    console.error(`[codex-web] 会话归属写入失败: ${err.message}`);
  }
}

// 管理员（threadsAll）可看全部；成员只能看自己发起的会话
function canSeeThread(actor, threadId) {
  if (actor.user.permissions.threadsAll) return true;
  return threadOwners[threadId] === actor.u;
}

// ---------------------------------------------------------------- 模型供应商（大模型 / API Key）
//
// 供应商配置由管理员在网页「设置 → 模型与 API Key」里维护，落在自己的 config.json 中：
//   * API Key 只以 AES-256-GCM 密文（enc:v1:...）保存，界面和接口只返回脱敏字符串；
//   * 运行任务时把明文密钥通过子进程环境变量注入（codex 的 `env_key`），
//     不写进命令行参数、不写进日志，`ps` 里看不到；
//   * codex 的 provider 配置通过 `-c model_providers.<id>.*` 覆盖项传入，
//     因此不需要改动 ~/.codex/config.toml，也不影响同机上其他 Codex 用法。

function findProvider(id) {
  const key = normalizeProviderId(id);
  if (!key) return null;
  return cfg.models.providers.find((provider) => provider.id === key) || null;
}

function activeProvider() {
  return findProvider(cfg.models.active) || cfg.models.providers[0] || null;
}

// 请求里的模型决定用哪个供应商：显式模型优先，否则用默认供应商
function resolveModel(requested) {
  const model = String(requested || "").trim();
  const provider = model
    ? cfg.models.providers.find((item) => item.models.includes(model)) || activeProvider()
    : activeProvider();
  if (model) return { model, provider };
  return { model: provider?.defaultModel || cfg.model || "", provider };
}

// 提供给前端的模型下拉列表（登录后即可看到，不含任何密钥信息）
function modelOptions() {
  const out = [];
  for (const provider of cfg.models.providers) {
    for (const model of provider.models) {
      out.push({ id: model, provider: provider.id, providerName: provider.name, label: `${model} · ${provider.name}` });
    }
  }
  if (cfg.model && !out.some((item) => item.id === cfg.model)) {
    out.push({ id: cfg.model, provider: "", providerName: "", label: `${cfg.model}（config.json 默认）` });
  }
  return out;
}

function adminProviderView(provider) {
  const fromEnv = Boolean(String(process.env[provider.envKey] || "").trim());
  return {
    id: provider.id,
    name: provider.name,
    baseUrl: provider.baseUrl,
    wireApi: provider.wireApi,
    envKey: provider.envKey,
    models: provider.models,
    defaultModel: provider.defaultModel,
    modelCatalog: provider.modelCatalog,
    reasoningEffort: provider.reasoningEffort,
    createdAt: provider.createdAt || "",
    updatedAt: provider.updatedAt || "",
    hasKey: Boolean(provider.apiKeyEnc),
    apiKeyMask: provider.apiKeyMask || "",
    keyFromEnv: fromEnv,
    active: provider.id === cfg.models.active,
    keySource: provider.apiKeyEnc ? "config" : fromEnv ? "env" : "none",
  };
}

// 运行任务时用于子进程的环境变量：优先用已保存的密文，其次交给调用方已有的环境变量
function providerEnv(provider) {
  if (!provider) return {};
  const key = decryptSecret(provider.apiKeyEnc, SECRET_KEY);
  if (key) return { [provider.envKey]: key };
  const inherited = String(process.env[provider.envKey] || "").trim();
  if (inherited) return {};
  console.warn(`[codex-web] 供应商 ${provider.id} 没有可用的 API Key，本次运行可能认证失败`);
  return {};
}

const tomlString = (value) => JSON.stringify(String(value ?? ""));

function expandHome(target) {
  const text = String(target || "");
  if (!text.startsWith("~")) return text;
  return path.join(os.homedir(), text.slice(1));
}

function providerArgs(provider) {
  if (!provider) return [];
  const prefix = `model_providers.${provider.id}`;
  const args = ["-c", `model_provider=${tomlString(provider.id)}`];
  args.push("-c", `${prefix}.name=${tomlString(provider.name)}`);
  if (provider.baseUrl) args.push("-c", `${prefix}.base_url=${tomlString(provider.baseUrl)}`);
  args.push("-c", `${prefix}.wire_api=${tomlString(provider.wireApi)}`);
  args.push("-c", `${prefix}.env_key=${tomlString(provider.envKey)}`);
  if (provider.modelCatalog) args.push("-c", `model_catalog_json=${tomlString(expandHome(provider.modelCatalog))}`);
  if (provider.reasoningEffort) {
    args.push("-c", `model_reasoning_effort=${tomlString(provider.reasoningEffort)}`);
  }
  return args;
}

// 供应商连通性测试：直接请求 OpenAI 兼容的 /models，不会消耗 token
async function probeProvider(provider) {
  if (!provider.baseUrl) return { ok: false, error: "该供应商没有填写 base_url" };
  let url;
  try {
    url = new URL(`${provider.baseUrl.replace(/\/+$/, "")}/models`);
  } catch {
    return { ok: false, error: `base_url 不是合法的地址：${provider.baseUrl}` };
  }
  if (!/^https?:$/.test(url.protocol)) return { ok: false, error: "只支持 http/https 地址" };

  const stored = decryptSecret(provider.apiKeyEnc, SECRET_KEY);
  const key = stored || String(process.env[provider.envKey] || "").trim();
  const keySource = stored ? "config" : key ? "env" : "none";
  try {
    const res = await fetch(url, {
      headers: key ? { Authorization: `Bearer ${key}` } : {},
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text().catch(() => "");
    const detail = text.replace(/\s+/g, " ").slice(0, 300);
    if (res.status === 404) {
      return {
        ok: keySource !== "none",
        status: res.status,
        url: url.toString(),
        keySource,
        message: "该服务没有 /models 接口，无法用这种方式验证；密钥本身仍然会被正常使用",
      };
    }
    return {
      ok: res.ok,
      status: res.status,
      url: url.toString(),
      keySource,
      message: res.ok ? "连接正常，密钥可用" : detail || `HTTP ${res.status}`,
    };
  } catch (err) {
    return { ok: false, url: url.toString(), keySource, error: `请求失败：${err.message}` };
  }
}

// ---------------------------------------------------------------- 本机权限控制（本地策略）
//
// 这是「产品层面」的护栏：限制 Codex 能进哪些目录、能跑哪些命令、不能改哪些路径，并留下审计日志。
// 它不是操作系统级隔离 —— 拿到 danger-full-access 的账号依然能读写整机，真正要硬隔离请用容器/虚拟机。

function policyRoots(kind) {
  const policy = normalizePolicy(cfg.policy);
  const roots = kind === "browse" ? policy.browseRoots : policy.allowedRoots;
  if (roots.length) return roots.map(expandHome);
  if (kind === "browse" && policy.allowedRoots.length) return policy.allowedRoots.map(expandHome);
  return [];
}

// target 是否位于 roots 之内（roots 为空表示不限制）
function pathInRoots(target, roots) {
  if (!roots.length) return true;
  const resolved = path.resolve(target);
  return roots.some((root) => {
    const base = path.resolve(root);
    if (resolved === base) return true;
    const prefix = base.endsWith(path.sep) ? base : `${base}${path.sep}`;
    return resolved.startsWith(prefix);
  });
}

function matchDeniedCommand(command) {
  if (!cfg.policy.enabled) return null;
  const text = String(command || "");
  if (!text) return null;
  for (const pattern of cfg.policy.denyCommands) {
    try {
      if (new RegExp(pattern, "i").test(text)) return pattern;
    } catch {
      /* 管理员可以填任意正则，写错了就跳过这一条 */
    }
  }
  return null;
}

function matchProtectedPath(filePath) {
  if (!cfg.policy.enabled) return null;
  const target = String(filePath || "").trim();
  if (!target) return null;
  const resolved = path.resolve(expandHome(target));
  for (const item of cfg.policy.protectPaths) {
    const base = path.resolve(expandHome(item));
    if (resolved === base || resolved.startsWith(base.endsWith(path.sep) ? base : `${base}${path.sep}`)) return item;
  }
  return null;
}

// 从事件流里识别危险动作：命中即终止本次任务
function inspectEventForPolicy(event) {
  const item = event?.item;
  if (!item || typeof item !== "object") return null;
  if (item.type === "command_execution" && typeof item.command === "string") {
    const pattern = matchDeniedCommand(item.command);
    if (pattern) return { kind: "command", pattern, detail: item.command.slice(0, 500) };
  }
  if (item.type === "file_change" && Array.isArray(item.changes)) {
    for (const change of item.changes) {
      const pattern = matchProtectedPath(change?.path);
      if (pattern) return { kind: "path", pattern, detail: String(change?.path || "") };
    }
  }
  return null;
}

// 普通成员只看得到和自己有关的策略概况
function policySummary() {
  const policy = normalizePolicy(cfg.policy);
  return {
    enabled: policy.enabled,
    allowedRoots: policy.allowedRoots,
    browseRoots: policyRoots("browse"),
    maxRunMinutes: policy.maxRunMinutes,
    allowNetwork: policy.allowNetwork,
    denyCount: policy.denyCommands.length,
    protectCount: policy.protectPaths.length,
  };
}

// ---------------------------------------------------------------- 审计日志

const AUDIT_PATH = path.join(DATA_DIR, "audit.jsonl");

function appendAudit(record) {
  if (!cfg.policy.audit) return;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(AUDIT_PATH, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  } catch (err) {
    console.error(`[codex-web] 审计日志写入失败: ${err.message}`);
  }
}

function readAudit(limit = 100) {
  try {
    const stat = fs.statSync(AUDIT_PATH);
    const start = Math.max(0, stat.size - 1024 * 1024);
    const handle = fs.openSync(AUDIT_PATH, "r");
    let text = "";
    try {
      const buf = Buffer.alloc(stat.size - start);
      fs.readSync(handle, buf, 0, buf.length, start);
      text = buf.toString("utf8");
    } finally {
      fs.closeSync(handle);
    }
    const lines = text.split("\n").filter(Boolean);
    if (start > 0) lines.shift(); // 截断处的半行丢掉
    const records = [];
    for (const line of lines) {
      try {
        records.push(JSON.parse(line));
      } catch {
        /* 忽略坏行 */
      }
    }
    return records.slice(-Math.max(1, Math.min(limit, 500))).reverse();
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------- codex sessions

const SESSIONS_DIR = path.join(cfg.codexHome, "sessions");
let threadIndex = { builtAt: 0, byId: new Map() };

async function collectSessionFiles(dir = SESSIONS_DIR, depth = 0, out = []) {
  if (depth > 4) return out;
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectSessionFiles(full, depth + 1, out);
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      try {
        const stat = await fsp.stat(full);
        out.push({ path: full, mtime: stat.mtimeMs, size: stat.size });
      } catch {
        /* ignore */
      }
    }
  }
  return out;
}

function extractMessageText(payload) {
  const content = payload?.content;
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => (typeof item?.text === "string" ? item.text : ""))
    .filter(Boolean)
    .join("\n");
}

async function readSessionMeta(file) {
  const handle = await fsp.open(file.path, "r");
  try {
    const buf = Buffer.alloc(Math.min(512 * 1024, file.size || 512 * 1024));
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    const lines = buf.subarray(0, bytesRead).toString("utf8").split("\n");
    let meta = null;
    let title = "";
    let firstUserAt = null;
    let turns = 0;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let obj;
      try {
        obj = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (obj.type === "session_meta" && !meta) {
        meta = {
          id: obj.payload?.session_id || obj.payload?.id || "",
          cwd: obj.payload?.cwd || "",
          model: obj.payload?.model || "",
          provider: obj.payload?.model_provider || "",
          originator: obj.payload?.originator || "",
          startedAt: obj.payload?.timestamp || obj.timestamp || "",
        };
      }
      if (
        !title &&
        obj.type === "response_item" &&
        obj.payload?.type === "message" &&
        obj.payload?.role === "user"
      ) {
        const text = extractMessageText(obj.payload).trim();
        if (text && !text.startsWith("<")) {
          title = text.replace(/\s+/g, " ").slice(0, 120);
          firstUserAt = obj.timestamp || null;
        }
      }
      if (obj.type === "response_item" && obj.payload?.type === "message" && obj.payload?.role === "assistant") {
        turns += 1;
      }
    }
    const id = meta?.id || path.basename(file.path).replace(/^rollout-/, "").replace(/\.jsonl$/, "");
    return {
      id,
      title: title || "(空会话)",
      cwd: meta?.cwd || "",
      model: meta?.model || "",
      provider: meta?.provider || "",
      originator: meta?.originator || "",
      startedAt: firstUserAt || meta?.startedAt || "",
      updatedAt: new Date(file.mtime).toISOString(),
      mtime: file.mtime,
      turns,
    };
  } finally {
    await handle.close();
  }
}

async function listThreads(limit = 80) {
  const files = await collectSessionFiles();
  files.sort((a, b) => b.mtime - a.mtime);
  const slice = files.slice(0, limit);
  const metas = [];
  for (const file of slice) {
    try {
      metas.push(await readSessionMeta(file));
    } catch {
      /* ignore unreadable session */
    }
  }
  threadIndex = { builtAt: Date.now(), byId: new Map(metas.map((m) => [m.id, m])) };
  return metas.filter((m) => m.title !== "(空会话)");
}

async function findSessionFile(id) {
  if (!threadIndex.byId.has(id) || Date.now() - threadIndex.builtAt > 30_000) {
    await listThreads();
  }
  const files = await collectSessionFiles();
  for (const file of files) {
    if (file.path.includes(id)) return file;
  }
  return null;
}

async function readThreadMessages(id) {
  const file = await findSessionFile(id);
  if (!file) return null;
  const text = await fsp.readFile(file.path, "utf8");
  const messages = [];
  let meta = null;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (obj.type === "session_meta") {
      meta = {
        id: obj.payload?.session_id || "",
        cwd: obj.payload?.cwd || "",
        model: obj.payload?.model || "",
        startedAt: obj.payload?.timestamp || "",
      };
      continue;
    }
    if (obj.type !== "response_item") continue;
    const p = obj.payload || {};
    if (p.type === "message" && (p.role === "user" || p.role === "assistant")) {
      const content = Array.isArray(p.content) ? p.content : [];
      if (content.some((item) => item?.type === "input_text" || item?.type === "output_text")) {
        const value = extractMessageText(p).trim();
        if (value) messages.push({ role: p.role, text: value, at: obj.timestamp });
      }
      continue;
    }
    if (p.type === "function_call") {
      messages.push({
        role: "tool",
        name: p.name || "tool",
        callId: p.call_id || p.id || "",
        args: p.arguments || "",
        at: obj.timestamp,
      });
      continue;
    }
    if (p.type === "function_call_output") {
      const last = [...messages].reverse().find((m) => m.role === "tool" && m.callId === (p.call_id || ""));
      const output =
        typeof p.output === "string" ? p.output : p.output ? JSON.stringify(p.output) : "";
      if (last) last.output = output.slice(0, 4000);
      else messages.push({ role: "tool", name: "tool", output: output.slice(0, 4000), at: obj.timestamp });
    }
  }
  return { meta, messages };
}

// ---------------------------------------------------------------- run management

let activeRuns = 0;
const runs = new Map();

function buildCodexArgs({ prompt, cwd, model, sandbox, threadId, provider }) {
  const args = ["exec", "--json", "--skip-git-repo-check", "--sandbox", sandbox];
  if (model) args.push("--model", model);
  args.push(...providerArgs(provider));
  // 关闭 workspace-write 沙箱下的联网能力（管理员可在「本机权限」里打开）
  if (!cfg.policy.allowNetwork) args.push("-c", "sandbox_workspace_write.network_access=false");
  if (threadId) {
    args.push("resume", threadId, prompt);
  } else {
    args.push("--cd", cwd, prompt);
  }
  return args;
}

async function handleRun(req, res, body, actor) {
  const prompt = String(body.prompt || "").trim();
  if (!prompt) return sendJSON(res, 400, { error: "prompt 不能为空" });

  const perms = actor.user.permissions;
  if (!perms.run) return sendJSON(res, 403, { error: "当前账号没有执行 Codex 的权限" });

  const defaultCwd = path.resolve(perms.defaultCwd || cfg.defaultCwd);
  const runRoots = policyRoots("run");
  const fallbackCwd = pathInRoots(defaultCwd, runRoots) ? defaultCwd : runRoots[0] || defaultCwd;
  const cwd = path.resolve(String(body.cwd || fallbackCwd));
  const threadId = body.threadId ? String(body.threadId) : "";
  const { model, provider } = resolveModel(body.model);
  let sandbox = String(body.sandbox || cfg.sandbox);

  if (SANDBOX_RANK[sandbox] === undefined) {
    return sendJSON(res, 400, { error: `不支持的 sandbox: ${sandbox}` });
  }
  // 超出账号权限上限时降级到上限，而不是直接失败
  if (SANDBOX_RANK[sandbox] > SANDBOX_RANK[perms.sandboxMax]) sandbox = perms.sandboxMax;
  // 没有目录浏览权限的账号只能在指定的默认目录里工作
  if (!perms.browse && cwd !== fallbackCwd) {
    return sendJSON(res, 403, { error: `当前账号只能使用工作目录 ${fallbackCwd}` });
  }
  // 本机权限控制：工作目录必须落在允许的根目录之内
  if (!pathInRoots(cwd, runRoots)) {
    return sendJSON(res, 403, {
      error: `工作目录 ${cwd} 不在管理员允许的范围内：${runRoots.join("、")}`,
    });
  }
  if (threadId && !canSeeThread(actor, threadId)) {
    return sendJSON(res, 403, { error: "无权继续该会话" });
  }
  if (!threadId) {
    try {
      const stat = await fsp.stat(cwd);
      if (!stat.isDirectory()) throw new Error("not a directory");
    } catch {
      return sendJSON(res, 400, { error: `工作目录不存在: ${cwd}` });
    }
  }
  if (activeRuns >= cfg.maxConcurrentRuns) {
    return sendJSON(res, 429, { error: "并发任务已达上限，请稍后再试" });
  }
  const ownRuns = [...runs.values()].filter((item) => item.user === actor.u).length;
  if (ownRuns >= cfg.maxConcurrentRunsPerUser) {
    return sendJSON(res, 429, { error: `每个账号同时最多运行 ${cfg.maxConcurrentRunsPerUser} 个任务` });
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  const runId = crypto.randomUUID();
  const args = buildCodexArgs({ prompt, cwd, model, sandbox, threadId, provider });
  const startedAt = Date.now();
  const violations = [];
  let blockedReason = "";
  activeRuns += 1;

  const write = (obj) => {
    if (res.writableEnded || res.destroyed) return;
    try {
      res.write(`data: ${JSON.stringify(obj)}\n\n`);
    } catch {
      /* client gone */
    }
  };

  write({
    type: "run.started",
    runId,
    cwd,
    model,
    provider: provider ? { id: provider.id, name: provider.name, wireApi: provider.wireApi } : null,
    sandbox,
    threadId,
    user: actor.u,
    args: args.slice(0, -1),
  });

  const child = spawn(cfg.codexBin, args, {
    cwd,
    env: { ...process.env, CODEX_HOME: cfg.codexHome, ...providerEnv(provider) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  runs.set(runId, { child, startedAt, prompt, user: actor.u, policyBlocked: false });

  const keepAlive = setInterval(() => {
    if (!res.writableEnded && !res.destroyed) res.write(": ping\n\n");
  }, 15_000);

  // 命中「本机权限」策略时立刻终止这次任务
  const blockRun = (violation, reason) => {
    if (blockedReason) return;
    blockedReason = reason;
    const record = { ...violation, reason, at: new Date().toISOString() };
    violations.push(record);
    const run = runs.get(runId);
    if (run) run.policyBlocked = true;
    write({
      type: "policy.blocked",
      runId,
      reason,
      kind: violation.kind,
      pattern: violation.pattern,
      detail: violation.detail,
      message:
        reason === "timeout"
          ? `任务超过 ${cfg.policy.maxRunMinutes} 分钟，已被本机权限策略终止`
          : violation.kind === "command"
            ? `命令命中管理员设置的禁止规则（${violation.pattern}），任务已被终止`
            : `操作涉及受保护路径 ${violation.pattern}，任务已被终止`,
    });
    run?.child.kill("SIGTERM");
    setTimeout(() => {
      const current = runs.get(runId);
      if (current && current.policyBlocked) current.child.kill("SIGKILL");
    }, 5000).unref();
  };

  const timeoutTimer =
    cfg.policy.enabled && cfg.policy.maxRunMinutes > 0
      ? setTimeout(
          () => blockRun({ kind: "timeout", pattern: `${cfg.policy.maxRunMinutes}min`, detail: "" }, "timeout"),
          cfg.policy.maxRunMinutes * 60_000
        )
      : null;

  let stdoutBuffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk;
    let idx;
    while ((idx = stdoutBuffer.indexOf("\n")) >= 0) {
      const line = stdoutBuffer.slice(0, idx).trim();
      stdoutBuffer = stdoutBuffer.slice(idx + 1);
      if (!line) continue;
      try {
        const event = JSON.parse(line);
        if (event.type === "thread.started" && event.thread_id) {
          recordThreadOwner(event.thread_id, actor.u);
        }
        write(event);
        const violation = inspectEventForPolicy(event);
        if (violation) blockRun(violation, "policy");
      } catch {
        write({ type: "log", text: line });
      }
    }
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    for (const line of String(chunk).split("\n")) {
      if (line.trim()) write({ type: "log", text: line.trim() });
    }
  });

  child.on("error", (err) => write({ type: "error", message: err.message }));

  const finish = (code, signal) => {
    clearInterval(keepAlive);
    if (timeoutTimer) clearTimeout(timeoutTimer);
    runs.delete(runId);
    activeRuns = Math.max(0, activeRuns - 1);
    appendAudit({
      at: new Date().toISOString(),
      runId,
      user: actor.u,
      cwd,
      sandbox,
      model,
      provider: provider?.id || "",
      threadId: threadId || "",
      prompt: prompt.replace(/\s+/g, " ").slice(0, 300),
      exitCode: code,
      signal: signal || "",
      durationMs: Date.now() - startedAt,
      blockedReason,
      violations,
    });
    write({ type: "run.exited", runId, code, signal, durationMs: Date.now() - startedAt });
    if (!res.writableEnded) res.end();
  };

  child.on("close", finish);
  res.on("close", () => {
    const run = runs.get(runId);
    if (run) {
      run.child.kill("SIGTERM");
      setTimeout(() => {
        if (runs.has(runId)) runs.get(runId).child.kill("SIGKILL");
      }, 5000).unref();
    }
  });
}

function stopRun(runId) {
  const run = runs.get(runId);
  if (!run) return false;
  run.child.kill("SIGTERM");
  setTimeout(() => run.child.kill("SIGKILL"), 5000).unref();
  return true;
}

// ---------------------------------------------------------------- filesystem browsing

async function listDirectory(target) {
  const dir = path.resolve(String(target || cfg.defaultCwd));
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const items = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    let size = null;
    let mtime = null;
    try {
      const stat = await fsp.stat(full);
      size = stat.size;
      mtime = stat.mtimeMs;
    } catch {
      /* unreadable */
    }
    items.push({
      name: entry.name,
      path: full,
      dir: entry.isDirectory(),
      size,
      mtime,
    });
  }
  items.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
  return { path: dir, parent: path.dirname(dir), items };
}

// ---------------------------------------------------------------- static files

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
};

async function serveStatic(req, res, pathname) {
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const full = path.join(PUBLIC_DIR, rel);
  if (!full.startsWith(PUBLIC_DIR)) return sendJSON(res, 403, { error: "forbidden" });
  try {
    const data = await fsp.readFile(full);
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(full)] || "application/octet-stream",
      "Cache-Control": "no-cache",
      "Content-Length": data.length,
    });
    res.end(data);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
}

// ---------------------------------------------------------------- router

// 首次登录（或用默认密码登录）必须先改密码：这些接口在改完之前一律不可用
const PASSWORD_CHANGE_EXEMPT = new Set(["/api/login", "/api/logout", "/api/password", "/api/session"]);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const { pathname } = url;

  try {
    // 强制改密拦截：只放行登录、退出、改密与 /api/session（前端要靠它跳转改密页）
    if (pathname.startsWith("/api/") && !PASSWORD_CHANGE_EXEMPT.has(pathname)) {
      const actor = currentUser(req);
      if (actor?.user?.mustChangePassword) {
        return sendJSON(res, 403, {
          error: "首次登录必须先修改密码，修改后才能使用其他功能",
          code: "password_change_required",
        });
      }
    }

    if (pathname === "/api/login" && req.method === "POST") {
      const body = await readBody(req);
      const ip = clientIp(req);
      const username = String(body.username || "").trim();
      const password = String(body.password || "").trim();
      const agent = String(req.headers["user-agent"] || "").slice(0, 120);

      const blocked = loginBlockSeconds(ip);
      if (blocked > 0) {
        res.setHeader("Retry-After", String(blocked));
        console.warn(`[codex-web] 登录被限流 ip=${ip}`);
        return sendJSON(res, 429, { error: `失败次数过多，请 ${blocked} 秒后再试` });
      }

      const account = verifyCredentials(username, password);
      if (!account) {
        recordLoginFailure(ip);
        console.warn(
          `[codex-web] 登录失败 ip=${ip} user="${username}" 密码长度=${password.length} ua="${agent}"`
        );
        await new Promise((r) => setTimeout(r, 400));
        return sendJSON(res, 401, { error: "用户名或密码错误" });
      }
      loginAttempts.delete(ip);
      account.lastLoginAt = new Date().toISOString();
      try {
        persistConfig();
      } catch (err) {
        console.error(`[codex-web] 记录登录时间失败: ${err.message}`);
      }
      console.log(`[codex-web] 登录成功 ip=${ip} user="${account.username}" role=${account.role}`);
      res.setHeader("Set-Cookie", sessionCookie(makeToken(account.username), req));
      return sendJSON(res, 200, { ok: true, username: account.username, role: account.role });
    }

    if (pathname === "/api/password" && req.method === "POST") {
      const actor = currentUser(req);
      if (!actor) return sendJSON(res, 401, { error: "unauthorized" });
      const account = actor.user;
      const body = await readBody(req);
      const currentPassword = String(body.currentPassword || "").trim();
      const newPassword = String(body.newPassword || "").trim();

      if (!verifyCredentials(account.username, currentPassword)) {
        await new Promise((r) => setTimeout(r, 400));
        return sendJSON(res, 400, { error: "当前密码不正确" });
      }
      if (newPassword.length < 8) return sendJSON(res, 400, { error: "新密码至少 8 位" });
      if (newPassword.length > 200) return sendJSON(res, 400, { error: "新密码过长" });
      if (newPassword === currentPassword) {
        return sendJSON(res, 400, { error: "新密码不能与当前密码相同" });
      }

      account.passwordHash = hashPassword(newPassword);
      account.password = "";
      // 改完密码即解除强制改密状态
      account.mustChangePassword = false;
      // 只让这个账号的其他设备下线，不影响其他成员
      account.sessionVersion = Number(account.sessionVersion || 0) + 1;
      try {
        persistConfig();
      } catch (err) {
        return sendJSON(res, 500, { error: `配置写入失败: ${err.message}` });
      }
      res.setHeader("Set-Cookie", sessionCookie(makeToken(account.username), req));
      return sendJSON(res, 200, { ok: true, message: "密码已更新，该账号其他设备的登录已失效" });
    }

    if (pathname === "/api/logout" && req.method === "POST") {
      res.setHeader("Set-Cookie", "codex_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
      return sendJSON(res, 200, { ok: true });
    }

    // ------------------------------------------------------------ 账号管理（管理员）

    if (pathname === "/api/admin/users" && req.method === "GET") {
      const actor = requireManage(req, res);
      if (!actor) return;
      return sendJSON(res, 200, {
        users: cfg.users.map(publicUser),
        sandboxLevels: Object.keys(SANDBOX_RANK),
        limits: {
          maxConcurrentRuns: cfg.maxConcurrentRuns,
          maxConcurrentRunsPerUser: cfg.maxConcurrentRunsPerUser,
        },
        currentUser: actor.u,
      });
    }

    if (pathname === "/api/admin/users" && req.method === "POST") {
      const actor = requireManage(req, res);
      if (!actor) return;
      const body = await readBody(req);
      const username = String(body.username || "").trim();
      if (!/^[A-Za-z0-9._-]{2,32}$/.test(username)) {
        return sendJSON(res, 400, { error: "账号需为 2-32 位字母、数字、点、下划线或短横线" });
      }
      if (findUser(username)) return sendJSON(res, 409, { error: "该账号已存在" });
      const password = String(body.password || "");
      if (password.length < 8) return sendJSON(res, 400, { error: "密码至少 8 位" });
      if (password.length > 200) return sendJSON(res, 400, { error: "密码过长" });

      const role = body.role === "admin" ? "admin" : "member";
      const user = normalizeUserRecord({
        username,
        displayName: body.displayName,
        passwordHash: hashPassword(password),
        role,
        disabled: Boolean(body.disabled),
        createdAt: new Date().toISOString(),
        // 默认要求新账号首次登录改密码（管理员可以显式关掉）
        mustChangePassword: body.mustChangePassword === undefined ? true : Boolean(body.mustChangePassword),
        permissions: body.permissions,
      });
      cfg.users.push(user);
      try {
        persistConfig();
      } catch (err) {
        cfg.users = cfg.users.filter((item) => item !== user);
        return sendJSON(res, 500, { error: `配置写入失败: ${err.message}` });
      }
      console.log(`[codex-web] 新建账号 "${user.username}"（${user.role}）by ${actor.u}`);
      return sendJSON(res, 200, { ok: true, user: publicUser(user) });
    }

    if (pathname.startsWith("/api/admin/users/") && req.method === "POST") {
      const actor = requireManage(req, res);
      if (!actor) return;
      const rest = decodeURIComponent(pathname.slice("/api/admin/users/".length));
      const isDelete = rest.endsWith("/delete");
      const target = findUser(isDelete ? rest.slice(0, -"/delete".length) : rest);
      if (!target) return sendJSON(res, 404, { error: "账号不存在" });
      const isSelf = target.username.toLowerCase() === actor.user.username.toLowerCase();

      if (isDelete) {
        if (isSelf) return sendJSON(res, 400, { error: "不能删除自己的账号" });
        if (target.role === "admin" && otherEnabledAdmins(target) === 0) {
          return sendJSON(res, 400, { error: "至少保留一个可用的管理员账号" });
        }
        cfg.users = cfg.users.filter((item) => item !== target);
        try {
          persistConfig();
        } catch (err) {
          cfg.users.push(target);
          return sendJSON(res, 500, { error: `配置写入失败: ${err.message}` });
        }
        console.log(`[codex-web] 删除账号 "${target.username}" by ${actor.u}`);
        return sendJSON(res, 200, { ok: true, deleted: target.username });
      }

      const body = await readBody(req);
      const nextRole = body.role === "admin" || body.role === "member" ? body.role : target.role;
      const nextDisabled = body.disabled === undefined ? target.disabled : Boolean(body.disabled);
      // 先把新密码校验干净，避免参数不合法时已经把角色/权限改了一半
      const newPassword = body.password ? String(body.password) : "";
      if (newPassword && newPassword.length < 8) return sendJSON(res, 400, { error: "密码至少 8 位" });
      if (newPassword.length > 200) return sendJSON(res, 400, { error: "密码过长" });

      if (isSelf && nextDisabled) return sendJSON(res, 400, { error: "不能禁用自己的账号" });
      if (isSelf && nextRole !== "admin") return sendJSON(res, 400, { error: "不能取消自己的管理员角色" });
      if (
        target.role === "admin" &&
        (nextRole !== "admin" || nextDisabled) &&
        otherEnabledAdmins(target) === 0
      ) {
        return sendJSON(res, 400, { error: "至少保留一个可用的管理员账号" });
      }

      const backup = structuredClone(target);
      // 禁用账号时同时作废其已下发的登录态，重新启用后旧 Cookie 也不会复活
      if (!target.disabled && nextDisabled) {
        target.sessionVersion = Number(target.sessionVersion || 0) + 1;
      }
      target.displayName = body.displayName === undefined ? target.displayName : String(body.displayName).trim();
      target.role = nextRole;
      target.disabled = nextDisabled;
      if (body.mustChangePassword !== undefined) {
        target.mustChangePassword = Boolean(body.mustChangePassword);
      }
      target.permissions = normalizePermissions(
        body.permissions ? { ...target.permissions, ...body.permissions } : target.permissions,
        nextRole
      );

      let passwordReset = false;
      if (newPassword) {
        target.passwordHash = hashPassword(newPassword);
        target.password = "";
        target.sessionVersion = Number(target.sessionVersion || 0) + 1;
        // 重置密码后默认要求对方下次登录改密码，除非请求里明确指定
        if (body.mustChangePassword === undefined) target.mustChangePassword = true;
        passwordReset = true;
      }
      if (body.signOutAll) {
        target.sessionVersion = Number(target.sessionVersion || 0) + 1;
      }

      try {
        persistConfig();
      } catch (err) {
        Object.assign(target, backup);
        return sendJSON(res, 500, { error: `配置写入失败: ${err.message}` });
      }
      console.log(`[codex-web] 更新账号 "${target.username}"（${target.role}${target.disabled ? ", 已禁用" : ""}）by ${actor.u}`);
      return sendJSON(res, 200, { ok: true, user: publicUser(target), passwordReset });
    }

    // ------------------------------------------------------------ 模型与 API Key（管理员）

    if (pathname === "/api/models" && req.method === "GET") {
      const actor = currentUser(req);
      if (!actor) return sendJSON(res, 401, { error: "unauthorized" });
      return sendJSON(res, 200, {
        models: modelOptions(),
        active: cfg.models.active,
        defaultModel: cfg.model || "",
      });
    }

    if (pathname === "/api/admin/models" && req.method === "GET") {
      const actor = requireManage(req, res);
      if (!actor) return;
      return sendJSON(res, 200, {
        active: cfg.models.active,
        providers: cfg.models.providers.map(adminProviderView),
        wireApis: WIRE_APIS,
        reasoningLevels: ["", "minimal", "low", "medium", "high", "max"],
      });
    }

    // 新增或更新供应商。apiKey 只在这次请求里出现明文，落盘前即被加密。
    if (pathname === "/api/admin/models" && req.method === "POST") {
      const actor = requireManage(req, res);
      if (!actor) return;
      const body = await readBody(req);
      const id = normalizeProviderId(body.id);
      if (!/^[a-z0-9_-]{2,40}$/.test(id)) {
        return sendJSON(res, 400, { error: "供应商 ID 需为 2-40 位小写字母、数字、短横线或下划线" });
      }
      const existing = findProvider(id);
      const models = Array.isArray(body.models)
        ? body.models
        : String(body.models || "")
            .split(/[\s,]+/)
            .filter(Boolean);
      let provider;
      try {
        provider = normalizeProvider(
          {
            ...(existing || {}),
            id,
            name: body.name === undefined ? existing?.name || id : body.name,
            baseUrl: body.baseUrl === undefined ? existing?.baseUrl || "" : body.baseUrl,
            wireApi: body.wireApi === undefined ? existing?.wireApi : body.wireApi,
            envKey: body.envKey === undefined ? existing?.envKey : body.envKey,
            models: models.length ? models : existing?.models || [],
            defaultModel: body.defaultModel === undefined ? existing?.defaultModel : body.defaultModel,
            modelCatalog: body.modelCatalog === undefined ? existing?.modelCatalog : body.modelCatalog,
            reasoningEffort:
              body.reasoningEffort === undefined ? existing?.reasoningEffort : body.reasoningEffort,
            apiKeyEnc: existing?.apiKeyEnc || "",
            apiKeyMask: existing?.apiKeyMask || "",
            apiKey: typeof body.apiKey === "string" ? body.apiKey.trim() : "",
            createdAt: existing?.createdAt,
          },
          { secretKey: SECRET_KEY }
        );
      } catch (err) {
        return sendJSON(res, 400, { error: err.message });
      }
      if (!provider) return sendJSON(res, 400, { error: "供应商 ID 不合法" });
      if (body.clearApiKey) {
        provider.apiKeyEnc = "";
        provider.apiKeyMask = "";
      }
      if (!provider.baseUrl) return sendJSON(res, 400, { error: "base_url 不能为空" });

      const backup = cfg.models.providers.slice();
      const backupActive = cfg.models.active;
      if (existing) {
        cfg.models.providers = cfg.models.providers.map((item) => (item.id === id ? provider : item));
      } else {
        cfg.models.providers.push(provider);
      }
      // 第一个供应商、或管理员勾选了「设为默认」时成为默认供应商
      if (body.active === true || !cfg.models.active || !findProvider(cfg.models.active)) {
        cfg.models.active = provider.id;
      }
      try {
        persistConfig();
      } catch (err) {
        cfg.models.providers = backup;
        cfg.models.active = backupActive;
        return sendJSON(res, 500, { error: `配置写入失败: ${err.message}` });
      }
      console.log(`[codex-web] 保存模型供应商 "${provider.id}" by ${actor.u}（apiKey=${provider.apiKeyEnc ? "已加密保存" : "无"}）`);
      return sendJSON(res, 200, { ok: true, provider: adminProviderView(provider), active: cfg.models.active });
    }

    if (pathname.startsWith("/api/admin/models/") && req.method === "POST") {
      const actor = requireManage(req, res);
      if (!actor) return;
      const rest = decodeURIComponent(pathname.slice("/api/admin/models/".length));
      const [rawId, ...actionParts] = rest.split("/");
      const action = actionParts.join("/");
      const provider = findProvider(rawId);
      if (!provider) return sendJSON(res, 404, { error: "供应商不存在" });

      if (action === "delete") {
        const backup = cfg.models.providers.slice();
        const backupActive = cfg.models.active;
        cfg.models.providers = cfg.models.providers.filter((item) => item !== provider);
        if (cfg.models.active === provider.id) cfg.models.active = cfg.models.providers[0]?.id || "";
        try {
          persistConfig();
        } catch (err) {
          cfg.models.providers = backup;
          cfg.models.active = backupActive;
          return sendJSON(res, 500, { error: `配置写入失败: ${err.message}` });
        }
        console.log(`[codex-web] 删除模型供应商 "${provider.id}" by ${actor.u}`);
        return sendJSON(res, 200, { ok: true, deleted: provider.id, active: cfg.models.active });
      }

      if (action === "activate") {
        const backup = cfg.models.active;
        cfg.models.active = provider.id;
        try {
          persistConfig();
        } catch (err) {
          cfg.models.active = backup;
          return sendJSON(res, 500, { error: `配置写入失败: ${err.message}` });
        }
        return sendJSON(res, 200, { ok: true, active: cfg.models.active });
      }

      if (action === "test") {
        const result = await probeProvider(provider);
        console.log(`[codex-web] 测试模型供应商 "${provider.id}" by ${actor.u}：${result.ok ? "成功" : "失败"}`);
        return sendJSON(res, 200, { ok: Boolean(result.ok), result });
      }

      if (action === "clear-key") {
        const backup = provider.apiKeyEnc;
        const backupMask = provider.apiKeyMask;
        provider.apiKeyEnc = "";
        provider.apiKeyMask = "";
        try {
          persistConfig();
        } catch (err) {
          provider.apiKeyEnc = backup;
          provider.apiKeyMask = backupMask;
          return sendJSON(res, 500, { error: `配置写入失败: ${err.message}` });
        }
        return sendJSON(res, 200, { ok: true, provider: adminProviderView(provider) });
      }

      return sendJSON(res, 404, { error: "不支持的操作" });
    }

    // ------------------------------------------------------------ 本机权限控制（管理员）

    if (pathname === "/api/admin/policy" && req.method === "GET") {
      const actor = requireManage(req, res);
      if (!actor) return;
      return sendJSON(res, 200, {
        policy: normalizePolicy(cfg.policy),
        defaults: defaultPolicy(),
        sandboxLevels: Object.keys(SANDBOX_RANK),
        codexBin: cfg.codexBin,
        codexHome: cfg.codexHome,
        maxConcurrentRuns: cfg.maxConcurrentRuns,
        maxConcurrentRunsPerUser: cfg.maxConcurrentRunsPerUser,
        audit: readAudit(50),
      });
    }

    if (pathname === "/api/admin/policy" && req.method === "POST") {
      const actor = requireManage(req, res);
      if (!actor) return;
      const body = await readBody(req);
      const next = normalizePolicy({ ...cfg.policy, ...(body.policy || {}) });
      const backup = cfg.policy;
      const nextConcurrent = body.limits || {};
      const applyLimits = (source) => {
        const global = Number(nextConcurrent.maxConcurrentRuns);
        const perUser = Number(nextConcurrent.maxConcurrentRunsPerUser);
        if (Number.isFinite(global) && global >= 1) source.maxConcurrentRuns = Math.min(Math.round(global), 50);
        if (Number.isFinite(perUser) && perUser >= 1) source.maxConcurrentRunsPerUser = Math.min(Math.round(perUser), 50);
        source.maxConcurrentRunsPerUser = Math.min(source.maxConcurrentRunsPerUser, source.maxConcurrentRuns);
      };
      const limitsBackup = { maxConcurrentRuns: cfg.maxConcurrentRuns, maxConcurrentRunsPerUser: cfg.maxConcurrentRunsPerUser };
      cfg.policy = next;
      applyLimits(cfg);
      try {
        persistConfig();
      } catch (err) {
        cfg.policy = backup;
        Object.assign(cfg, limitsBackup);
        return sendJSON(res, 500, { error: `配置写入失败: ${err.message}` });
      }
      console.log(
        `[codex-web] 更新本机权限策略 by ${actor.u}（${cfg.policy.enabled ? "已启用" : "已停用"}，允许目录 ${
          cfg.policy.allowedRoots.join("、") || "不限制"
        }）`
      );
      appendAudit({
        at: new Date().toISOString(),
        event: "policy.updated",
        user: actor.u,
        policy: cfg.policy,
      });
      return sendJSON(res, 200, {
        ok: true,
        policy: cfg.policy,
        maxConcurrentRuns: cfg.maxConcurrentRuns,
        maxConcurrentRunsPerUser: cfg.maxConcurrentRunsPerUser,
      });
    }

    if (pathname === "/api/admin/audit" && req.method === "GET") {
      const actor = requireManage(req, res);
      if (!actor) return;
      const limit = Number(url.searchParams.get("limit")) || 100;
      return sendJSON(res, 200, { entries: readAudit(limit) });
    }

    if (pathname === "/api/session" && req.method === "GET") {
      const actor = currentUser(req);
      if (!actor) return sendJSON(res, 401, { error: "unauthorized" });
      const perms = normalizePermissions(actor.user.permissions, actor.user.role);
      const runRoots = policyRoots("run");
      const userCwd = perms.defaultCwd || cfg.defaultCwd;
      return sendJSON(res, 200, {
        username: actor.user.username,
        displayName: actor.user.displayName || "",
        role: actor.user.role,
        permissions: perms,
        defaultCwd: pathInRoots(userCwd, runRoots) ? userCwd : runRoots[0] || userCwd,
        sandbox: SANDBOX_RANK[cfg.sandbox] > SANDBOX_RANK[perms.sandboxMax] ? perms.sandboxMax : cfg.sandbox,
        model: cfg.model,
        models: modelOptions(),
        activeProvider: cfg.models.active,
        policy: policySummary(),
        mustChangePassword: Boolean(actor.user.mustChangePassword),
        codexHome: cfg.codexHome,
      });
    }

    if (pathname === "/api/run" && req.method === "POST") {
      const actor = currentUser(req);
      if (!actor) return sendJSON(res, 401, { error: "unauthorized" });
      const body = await readBody(req);
      return handleRun(req, res, body, actor);
    }

    if (pathname === "/api/stop" && req.method === "POST") {
      const actor = currentUser(req);
      if (!actor) return sendJSON(res, 401, { error: "unauthorized" });
      const body = await readBody(req);
      const runId = String(body.runId || "");
      const run = runs.get(runId);
      if (run && run.user !== actor.u && !actor.user.permissions.manageUsers) {
        return sendJSON(res, 403, { error: "只能停止自己的任务" });
      }
      const ok = stopRun(runId);
      return sendJSON(res, 200, { ok });
    }

    if (pathname === "/api/threads" && req.method === "GET") {
      const actor = currentUser(req);
      if (!actor) return sendJSON(res, 401, { error: "unauthorized" });
      if (!actor.user.permissions.threads) return sendJSON(res, 403, { error: "当前账号没有查看历史会话的权限" });
      const threads = await listThreads(Number(url.searchParams.get("limit")) || 80);
      const visible = actor.user.permissions.threadsAll
        ? threads
        : threads.filter((thread) => threadOwners[thread.id] === actor.u);
      return sendJSON(res, 200, {
        threads: visible,
        scoped: !actor.user.permissions.threadsAll,
      });
    }

    if (pathname.startsWith("/api/threads/") && req.method === "GET") {
      const actor = currentUser(req);
      if (!actor) return sendJSON(res, 401, { error: "unauthorized" });
      if (!actor.user.permissions.threads) return sendJSON(res, 403, { error: "当前账号没有查看历史会话的权限" });
      const id = decodeURIComponent(pathname.slice("/api/threads/".length));
      if (!canSeeThread(actor, id)) return sendJSON(res, 403, { error: "无权查看该会话" });
      const thread = await readThreadMessages(id);
      if (!thread) return sendJSON(res, 404, { error: "会话不存在" });
      return sendJSON(res, 200, thread);
    }

    if (pathname === "/api/fs" && req.method === "GET") {
      const actor = currentUser(req);
      if (!actor) return sendJSON(res, 401, { error: "unauthorized" });
      if (!actor.user.permissions.browse) {
        return sendJSON(res, 403, { error: "当前账号没有浏览服务器目录的权限" });
      }
      const roots = policyRoots("browse");
      const requested = url.searchParams.get("path") || roots[0] || cfg.defaultCwd;
      if (!pathInRoots(requested, roots)) {
        return sendJSON(res, 403, { error: `只能浏览管理员允许的目录：${roots.join("、")}` });
      }
      try {
        const listing = await listDirectory(requested);
        return sendJSON(res, 200, listing);
      } catch (err) {
        return sendJSON(res, 400, { error: `无法读取目录: ${err.message}` });
      }
    }

    if (pathname.startsWith("/api/")) {
      return sendJSON(res, 404, { error: "not found" });
    }

    return serveStatic(req, res, pathname);
  } catch (err) {
    console.error("[codex-web] 请求处理失败:", err);
    if (!res.headersSent) sendJSON(res, 500, { error: err.message });
    else res.end();
  }
});

server.listen(cfg.port, cfg.host, () => {
  console.log(`[codex-web] listening on http://${cfg.host}:${cfg.port}`);
  console.log(`[codex-web] codex bin: ${cfg.codexBin} | sandbox: ${cfg.sandbox}`);
  const pending = cfg.users.filter((user) => user.mustChangePassword && !user.disabled);
  if (pending.length) {
    console.warn(
      `[codex-web] 注意：${pending
        .map((user) => user.username)
        .join("、")} 仍在使用初始/临时密码，登录后会要求先修改密码`
    );
  }
});
