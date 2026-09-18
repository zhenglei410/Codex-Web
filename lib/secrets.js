// API Key 等敏感信息的落盘加密与脱敏工具。
//
// 设计目标：
//   1. 明文密钥绝不写入 config.json，只保存 `enc:v1:...` 密文；
//   2. 密文用 AES-256-GCM 加密，密钥来自独立的密钥文件（或 CODEX_WEB_SECRET_KEY 环境变量），
//      因此只拿到 config.json（例如误传的备份、截图、仓库里的配置文件）也无法还原出明文；
//   3. 界面与接口只返回脱敏字符串（sk-****d00a），运行任务时密钥只通过子进程环境变量传递，
//      不会出现在命令行参数里（`ps` 看不到），也不会写进日志。
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const PREFIX = "enc:v1:";
// scrypt 参数：N 越大越慢，这里取 2^15，单次加解密约几十毫秒
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 };
const KEY_BYTES = 32;
const KEY_SALT = "codex-web-secret-key-v1";

export const SECRET_FILE_NAME = "secrets.key";

function deriveKey(secret, salt) {
  return crypto.scryptSync(String(secret), salt, KEY_BYTES, SCRYPT);
}

// 生成一个随机的 32 字节密钥（十六进制字符串，便于放进环境变量）
export function randomSecretKey() {
  return crypto.randomBytes(KEY_BYTES).toString("hex");
}

/**
 * 载入用于加密 API Key 的主密钥。
 * 优先级：CODEX_WEB_SECRET_KEY 环境变量 > data/secrets.key 文件 > 自动生成并写入文件。
 */
export function loadSecretKey({ dataDir, env = process.env } = {}) {
  const fromEnv = String(env.CODEX_WEB_SECRET_KEY || "").trim();
  if (fromEnv) return deriveKey(fromEnv, KEY_SALT);

  const file = path.join(dataDir || ".", SECRET_FILE_NAME);
  try {
    const existing = fs.readFileSync(file, "utf8").trim();
    if (existing) return deriveKey(existing, KEY_SALT);
  } catch {
    /* 首次运行还没有密钥文件 */
  }

  const generated = randomSecretKey();
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(file, `${generated}\n`, { mode: 0o600 });
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      /* 某些文件系统不支持 */
    }
    console.error(`[codex-web] 已生成 API Key 加密密钥 ${file}（请与 config.json 一起备份，丢失后需要重新填写 API Key）`);
  } catch (err) {
    console.error(`[codex-web] 无法写入加密密钥文件 ${file}: ${err.message}（本次运行使用临时密钥）`);
  }
  return deriveKey(generated, KEY_SALT);
}

export function isEncrypted(value) {
  return typeof value === "string" && value.startsWith(PREFIX);
}

// 返回 `enc:v1:<salt>:<iv>:<tag>:<ciphertext>`，全部为 base64url
export function encryptSecret(plaintext, key) {
  const text = String(plaintext ?? "");
  if (!text) return "";
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) throw new Error("加密密钥无效");
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const derived = deriveKey(key.toString("base64"), salt);
  const cipher = crypto.createCipheriv("aes-256-gcm", derived, iv);
  const body = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return (
    PREFIX +
    [salt, iv, tag, body].map((buf) => buf.toString("base64url")).join(":")
  );
}

// 解密失败（密钥换了、文件被改坏）返回 null，由调用方决定怎么提示
export function decryptSecret(blob, key) {
  if (!isEncrypted(blob) || !Buffer.isBuffer(key)) return null;
  const parts = blob.slice(PREFIX.length).split(":");
  if (parts.length !== 4) return null;
  try {
    const [salt, iv, tag, body] = parts.map((part) => Buffer.from(part, "base64url"));
    const derived = deriveKey(key.toString("base64"), salt);
    const decipher = crypto.createDecipheriv("aes-256-gcm", derived, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

/**
 * 脱敏展示：只保留开头 2-4 位与结尾 4 位，例如 `sk-719d…d00a` 显示成 `sk-****d00a`。
 * 太短的密钥一律显示为 `****`，避免脱敏后仍可被猜出。
 */
export function maskSecret(value) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  if (text.length <= 8) return "****";
  const head = text.slice(0, Math.min(3, text.indexOf("-") + 1 || 3));
  return `${head}****${text.slice(-4)}`;
}
