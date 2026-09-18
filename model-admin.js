#!/usr/bin/env node
// 模型供应商管理 CLI（网页端「设置 → 模型与 API Key」的等价命令行版本，适合脚本化部署）
//
// 用法：
//   node model-admin.js list
//   node model-admin.js add <id> --name DeepSeek --base-url https://api.deepseek.com \
//       --wire-api responses --env-key DEEPSEEK_API_KEY \
//       --models deepseek-chat,deepseek-reasoner --default deepseek-chat \
//       [--catalog ~/.codex/models.json] [--reasoning high] [--key sk-xxx | --key-env DEEPSEEK_API_KEY]
//   node model-admin.js set-key <id> <api-key>
//   node model-admin.js clear-key <id>
//   node model-admin.js activate <id>
//   node model-admin.js remove <id>
//   node model-admin.js test <id>
//   node model-admin.js import [--strip]      # 从 $CODEX_HOME/config.toml 导入已有供应商
//
// 说明：API Key 会以 AES-256-GCM 密文写入 config.json，明文只存在于内存和子进程环境变量里；
//      `list` 只显示脱敏后的 sk-****xxxx。
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { decryptSecret, loadSecretKey } from "./lib/secrets.js";
import { WIRE_APIS, loadConfig, normalizeProvider, normalizeProviderId, persistConfig } from "./lib/store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = process.env.CODEX_WEB_CONFIG || path.join(__dirname, "config.json");
const DATA_DIR = process.env.CODEX_WEB_DATA_DIR || path.join(__dirname, "data");
const SECRET_KEY = loadSecretKey({ dataDir: DATA_DIR });
const cfg = loadConfig(CONFIG_PATH, { secretKey: SECRET_KEY });

function parseFlags(args) {
  const flags = {};
  for (let i = 0; i < args.length; i += 1) {
    if (!args[i].startsWith("--")) continue;
    const key = args[i].slice(2);
    const next = args[i + 1];
    flags[key] = next && !next.startsWith("--") ? args[++i] : true;
  }
  return flags;
}

function usage() {
  console.log(`用法：
  node model-admin.js list
  node model-admin.js add <id> [--name 名称] [--base-url URL] [--wire-api responses|chat]
      [--env-key ENV_NAME] [--models m1,m2] [--default m1] [--catalog ~/.codex/models.json]
      [--reasoning minimal|low|medium|high|max] [--key sk-xxx | --key-env ENV_NAME] [--activate]
  node model-admin.js set-key <id> <api-key>
  node model-admin.js clear-key <id>
  node model-admin.js activate <id>
  node model-admin.js remove <id>
  node model-admin.js test <id>
  node model-admin.js import [--strip] [--activate]`);
}

function find(id) {
  const key = normalizeProviderId(id);
  return cfg.models.providers.find((provider) => provider.id === key) || null;
}

function save() {
  persistConfig(CONFIG_PATH, cfg);
}

async function probe(provider) {
  const url = new URL(`${provider.baseUrl.replace(/\/+$/, "")}/models`);
  const key = decryptSecret(provider.apiKeyEnc, SECRET_KEY) || String(process.env[provider.envKey] || "").trim();
  const res = await fetch(url, {
    headers: key ? { Authorization: `Bearer ${key}` } : {},
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text().catch(() => "");
  return { ok: res.ok, status: res.status, detail: text.replace(/\s+/g, " ").slice(0, 200) };
}

// 极简 TOML 读取：只认我们关心的字段，够用且零依赖
function readCodexConfigToml() {
  const home = String(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"));
  const file = path.join(home, "config.toml");
  const text = fs.readFileSync(file, "utf8");
  const top = {};
  const providers = {};
  let section = "";
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const header = line.match(/^\[([^\]]+)\]$/);
    if (header) {
      section = header[1].trim();
      continue;
    }
    const kv = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1];
    let value = kv[2].trim();
    const quoted = value.match(/^"(.*)"$/) || value.match(/^'(.*)'$/);
    value = quoted ? quoted[1] : value;
    if (section.startsWith("model_providers.")) {
      const id = normalizeProviderId(section.slice("model_providers.".length));
      providers[id] = providers[id] || {};
      providers[id][key] = value;
    } else if (!section) {
      top[key] = value;
    }
  }
  return { file, text, top, providers };
}

// 从 model_catalog_json 里读出可用模型名，导入时自动填进模型列表
function readCatalogModels(catalogPath) {
  const target = String(catalogPath || "").trim();
  if (!target) return [];
  const file = target.startsWith("~") ? path.join(os.homedir(), target.slice(1)) : target;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    const list = Array.isArray(parsed?.models) ? parsed.models : [];
    return list.map((item) => String(item?.slug || "").trim()).filter(Boolean);
  } catch {
    return [];
  }
}

const [command, ...rest] = process.argv.slice(2);

switch (command) {
  case "list": {
    if (!cfg.models.providers.length) console.log("（还没有配置任何模型供应商）");
    for (const provider of cfg.models.providers) {
      const marker = provider.id === cfg.models.active ? "*" : " ";
      const keyState = provider.apiKeyEnc
        ? `密钥 ${provider.apiKeyMask || "已保存"}`
        : process.env[provider.envKey]
          ? `密钥来自环境变量 ${provider.envKey}`
          : "无密钥";
      console.log(
        `${marker} ${provider.id.padEnd(16)} ${provider.name.padEnd(20)} ${provider.wireApi.padEnd(9)} ${keyState}`
      );
      console.log(`  base_url=${provider.baseUrl || "(未填写)"}`);
      console.log(`  模型=${provider.models.join(", ") || "(未填写)"} 默认=${provider.defaultModel || "-"}`);
    }
    if (cfg.models.providers.length) console.log("\n* 表示默认供应商");
    break;
  }
  case "add": {
    const [id] = rest;
    const flags = parseFlags(rest.slice(1));
    if (!id) {
      usage();
      break;
    }
    const normalized = normalizeProviderId(id);
    if (!/^[a-z0-9_-]{2,40}$/.test(normalized)) {
      console.error("供应商 ID 需为 2-40 位小写字母、数字、短横线或下划线");
      process.exit(1);
    }
    const existing = find(normalized);
    const fromEnvName = typeof flags["key-env"] === "string" ? flags["key-env"] : "";
    const apiKey =
      typeof flags.key === "string" ? flags.key : fromEnvName ? String(process.env[fromEnvName] || "") : "";
    if (fromEnvName && !apiKey) {
      console.error(`环境变量 ${fromEnvName} 为空，未保存密钥`);
      process.exit(1);
    }
    const models = String(flags.models || "")
      .split(/[\s,]+/)
      .filter(Boolean);
    const provider = normalizeProvider(
      {
        ...(existing || {}),
        id: normalized,
        name: typeof flags.name === "string" ? flags.name : existing?.name || id,
        baseUrl: typeof flags["base-url"] === "string" ? flags["base-url"] : existing?.baseUrl || "",
        wireApi: WIRE_APIS.includes(flags["wire-api"]) ? flags["wire-api"] : existing?.wireApi || "responses",
        envKey: typeof flags["env-key"] === "string" ? flags["env-key"] : existing?.envKey || "",
        models: models.length ? models : existing?.models || [],
        defaultModel: typeof flags.default === "string" ? flags.default : existing?.defaultModel || "",
        modelCatalog: typeof flags.catalog === "string" ? flags.catalog : existing?.modelCatalog || "",
        reasoningEffort: typeof flags.reasoning === "string" ? flags.reasoning : existing?.reasoningEffort || "",
        apiKeyEnc: existing?.apiKeyEnc || "",
        apiKeyMask: existing?.apiKeyMask || "",
        apiKey,
        createdAt: existing?.createdAt,
      },
      { secretKey: SECRET_KEY }
    );
    if (existing) cfg.models.providers = cfg.models.providers.map((item) => (item.id === normalized ? provider : item));
    else cfg.models.providers.push(provider);
    if (flags.activate || !cfg.models.active) cfg.models.active = provider.id;
    save();
    console.log(
      `已保存供应商 ${provider.id}（模型：${provider.models.join(", ") || "-"}；密钥：${
        provider.apiKeyEnc ? provider.apiKeyMask : "未保存"
      }）`
    );
    break;
  }
  case "set-key": {
    const [id, apiKey] = rest;
    const provider = find(id);
    if (!provider || !apiKey) {
      usage();
      break;
    }
    const next = normalizeProvider({ ...provider, apiKey }, { secretKey: SECRET_KEY });
    cfg.models.providers = cfg.models.providers.map((item) => (item.id === next.id ? next : item));
    save();
    console.log(`已更新 ${next.id} 的 API Key（密文保存）：${next.apiKeyMask}`);
    break;
  }
  case "clear-key": {
    const provider = find(rest[0]);
    if (!provider) {
      console.error(`供应商 ${rest[0]} 不存在`);
      process.exit(1);
    }
    provider.apiKeyEnc = "";
    provider.apiKeyMask = "";
    save();
    console.log(`已删除 ${provider.id} 保存的 API Key`);
    break;
  }
  case "activate": {
    const provider = find(rest[0]);
    if (!provider) {
      console.error(`供应商 ${rest[0]} 不存在`);
      process.exit(1);
    }
    cfg.models.active = provider.id;
    save();
    console.log(`默认供应商已设为 ${provider.id}`);
    break;
  }
  case "remove": {
    const provider = find(rest[0]);
    if (!provider) {
      console.error(`供应商 ${rest[0]} 不存在`);
      process.exit(1);
    }
    cfg.models.providers = cfg.models.providers.filter((item) => item !== provider);
    if (cfg.models.active === provider.id) cfg.models.active = cfg.models.providers[0]?.id || "";
    save();
    console.log(`已删除供应商 ${provider.id}`);
    break;
  }
  case "test": {
    const provider = find(rest[0]);
    if (!provider) {
      console.error(`供应商 ${rest[0]} 不存在`);
      process.exit(1);
    }
    try {
      const result = await probe(provider);
      console.log(result.ok ? `连接正常（HTTP ${result.status}）` : `连接失败（HTTP ${result.status}）：${result.detail}`);
    } catch (err) {
      console.error(`请求失败：${err.message}`);
      process.exit(1);
    }
    break;
  }
  case "import": {
    const flags = parseFlags(rest);
    let parsed;
    try {
      parsed = readCodexConfigToml();
    } catch (err) {
      console.error(`读取 CODEX_HOME/config.toml 失败：${err.message}`);
      process.exit(1);
    }
    const entries = Object.entries(parsed.providers);
    if (!entries.length) {
      console.log(`${parsed.file} 里没有 [model_providers.*] 配置`);
      break;
    }
    let imported = 0;
    for (const [id, raw] of entries) {
      const existing = find(id);
      const token = String(raw.experimental_bearer_token || raw.api_key || "").trim();
      const catalog = parsed.top.model_catalog_json || existing?.modelCatalog || "";
      const catalogModels = readCatalogModels(catalog);
      const modelNames = catalogModels.length
        ? [...new Set([...(existing?.models || []), ...catalogModels])]
        : existing?.models?.length
          ? existing.models
          : parsed.top.model
            ? [parsed.top.model]
            : [];
      const provider = normalizeProvider(
        {
          ...(existing || {}),
          id,
          name: raw.name || existing?.name || id,
          baseUrl: raw.base_url || existing?.baseUrl || "",
          wireApi: WIRE_APIS.includes(raw.wire_api) ? raw.wire_api : existing?.wireApi || "responses",
          envKey: raw.env_key || existing?.envKey || "",
          models: modelNames,
          defaultModel: existing?.defaultModel || (parsed.top.model_provider === id ? parsed.top.model : ""),
          modelCatalog: catalog,
          reasoningEffort: parsed.top.model_reasoning_effort || existing?.reasoningEffort || "",
          apiKeyEnc: existing?.apiKeyEnc || "",
          apiKeyMask: existing?.apiKeyMask || "",
          apiKey: token,
          createdAt: existing?.createdAt,
        },
        { secretKey: SECRET_KEY }
      );
      if (existing) cfg.models.providers = cfg.models.providers.map((item) => (item.id === id ? provider : item));
      else cfg.models.providers.push(provider);
      if (parsed.top.model_provider === id || cfg.models.providers.length === 1) cfg.models.active = id;
      imported += 1;
      console.log(
        `导入 ${id}：base_url=${provider.baseUrl || "-"} 模型=${provider.models.join(", ") || "-"} 密钥=${
          provider.apiKeyEnc ? provider.apiKeyMask : "未找到明文（可能已在环境变量里）"
        }`
      );
    }
    if (flags.strip) {
      const stripped = parsed.text
        .split("\n")
        .filter((line) => !/^\s*(experimental_bearer_token|api_key)\s*=/.test(line))
        .join("\n");
      const backup = `${parsed.file}.bak-${Date.now()}`;
      fs.writeFileSync(backup, parsed.text, { mode: 0o600 });
      fs.writeFileSync(parsed.file, stripped, { mode: 0o600 });
      console.log(`已从 ${parsed.file} 删除明文密钥（备份：${backup}）`);
    } else {
      console.log(`提示：加 --strip 可从 ${parsed.file} 中删除明文密钥，Codex Web 会改用加密保存的密钥。`);
    }
    save();
    console.log(`共导入 ${imported} 个供应商，默认供应商：${cfg.models.active || "-"}`);
    break;
  }
  default:
    usage();
}
