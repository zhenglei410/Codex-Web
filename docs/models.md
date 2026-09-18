# 模型供应商与 API Key

Codex Web 不绑定任何一家模型服务：它把供应商信息翻译成 Codex CLI 的命令行配置覆盖项
（`-c model_providers.<id>.*`），并把 API Key 通过**子进程环境变量**交给 Codex（Codex 侧的 `env_key` 机制）。
因此：

- 不需要修改 `~/.codex/config.toml`，也不会影响同机上其他 Codex 用法；
- 明文密钥不写盘、不进命令行参数、不进日志（`ps` 看不到）；
- 换模型只是换一个下拉框选项。

## 1. 在网页里配置（推荐）

**设置 → 模型与 API Key → 新增供应商**

| 字段 | 示例 | 说明 |
| --- | --- | --- |
| 供应商 ID | `deepseek` | 小写字母/数字/`-`/`_`，会成为 `-c model_providers.deepseek.*` |
| 显示名称 | `DeepSeek` | 下拉框显示用 |
| API Base URL | `https://api.deepseek.com` | 不要带 `/responses`、`/chat/completions` 等路径 |
| 接口类型 | `responses` / `chat` | 见下文「wire_api 怎么选」 |
| 密钥环境变量名 | `DEEPSEEK_API_KEY` | 留空自动生成 `<ID>_API_KEY` |
| API Key | `sk-…` | 保存后立即加密；再次编辑时留空表示沿用 |
| 模型列表 | `deepseek-chat, deepseek-reasoner` | 会出现在右上角下拉框 |
| 默认模型 | `deepseek-chat` | 留空用列表第一个 |
| 模型目录文件 | `~/.codex/models.json` | 可选，映射到 `model_catalog_json` |
| 推理强度 | `high` | 可选，映射到 `model_reasoning_effort` |

保存后点 **测试连接**：它会请求 `${baseUrl}/models`（OpenAI 兼容接口的模型列表），
只验证地址与鉴权，不消耗 token。若服务没有该接口，会返回「无法用这种方式验证」而不是失败。

## 2. 用命令行配置

```bash
node model-admin.js list

node model-admin.js add deepseek \
  --name DeepSeek \
  --base-url https://api.deepseek.com \
  --wire-api responses \
  --models deepseek-chat,deepseek-reasoner \
  --default deepseek-chat \
  --reasoning high \
  --key 'sk-你的密钥' \
  --activate

node model-admin.js set-key deepseek 'sk-新的密钥'
node model-admin.js test deepseek
node model-admin.js activate deepseek
node model-admin.js clear-key deepseek
node model-admin.js remove deepseek
```

密钥也可以不落在 `config.json` 里，而是交给环境变量（systemd `Environment=`、Docker `-e`、K8s Secret）：

```bash
node model-admin.js add deepseek --base-url https://api.deepseek.com \
  --wire-api responses --models deepseek-chat --key-env DEEPSEEK_API_KEY
```

## 3. 从现有 `~/.codex/config.toml` 导入

如果你已经在 Codex CLI 里配好了供应商（包括 `experimental_bearer_token` 这种明文写法），
可以直接导入并让 Codex Web 接管密钥：

```bash
node model-admin.js import            # 只导入，保留 config.toml 原样
node model-admin.js import --strip    # 导入后从 config.toml 删除明文密钥（会先备份 config.toml.bak-*）
```

导入会读取 `model` / `model_provider` / `model_catalog_json` / `model_reasoning_effort`
以及各 `[model_providers.*]` 段，并把明文 token 加密存进 `config.json`。

> `--strip` 之后，直接运行 `codex`（不经过 Codex Web）将不再有 API Key，
> 需要把密钥放进环境变量（例如写进 `~/.bashrc` 或用 systemd `Environment=`）再配合 `env_key`。
> 不确定就先不加 `--strip`。

## 4. 常见供应商示例

| 供应商 | base_url | wire_api | 模型名示例 |
| --- | --- | --- | --- |
| DeepSeek | `https://api.deepseek.com` | `responses`（官方 Responses 兼容）或 `chat` | `deepseek-chat`、`deepseek-reasoner` |
| OpenAI | `https://api.openai.com/v1` | `responses` | `gpt-5-codex`、`gpt-5` |
| 阿里云百炼（通义千问） | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `chat` | `qwen3-coder-plus`、`qwen-max` |
| 智谱 GLM | `https://open.bigmodel.cn/api/paas/v4` | `chat` | `glm-4.6`、`glm-4.5-air` |
| Moonshot(Kimi) | `https://api.moonshot.cn/v1` | `chat` | `kimi-k2-0905-preview` |
| 本地 Ollama | `http://127.0.0.1:11434/v1` | `chat` | `qwen3-coder:30b` |
| 本地 vLLM | `http://127.0.0.1:8000/v1` | `chat` | 你部署的模型名 |
| Azure OpenAI | `https://<资源名>.openai.azure.com/openai/v1` | `responses` | 你的部署名 |

> 各家的模型名与可用接口会变，以官方文档为准。命令行里用 `node model-admin.js test <id>` 验证。

## 5. wire_api 怎么选

| 取值 | 含义 | 什么时候用 |
| --- | --- | --- |
| `responses` | OpenAI Responses API（`POST {base_url}/responses`） | OpenAI 官方、以及宣称兼容 Responses 的服务（如 DeepSeek） |
| `chat` | OpenAI Chat Completions API（`POST {base_url}/chat/completions`） | 只兼容 Chat Completions 的服务（大多数国产模型、Ollama、vLLM） |

选错的典型表现是 404 / 400（路径不存在或请求体字段不被识别）。如果供应商同时支持两者，
优先 `responses`：Codex 在该协议下的工具调用与思考摘要体验更完整。

## 6. 模型元数据（`model_catalog_json`）

Codex 内置了一份模型元数据（上下文窗口、推理档位等）。当模型不在其中时会出现：

```
Model metadata for `xxx` not found. Defaulting to fallback metadata; this can degrade performance…
```

两种处理方式：

1. 接受它：Codex 用兜底元数据继续工作；
2. 提供目录文件：仿照 `~/.codex/models.json` 写一份，在供应商里填「模型目录文件」路径
   （支持 `~` 开头）。`node model-admin.js import` 会把 `config.toml` 里的
   `model_catalog_json` 一并导入，并按里面的 `slug` 自动填好模型列表。

## 7. 密钥的保存与安全

| 环节 | 做法 |
| --- | --- |
| 落盘 | AES-256-GCM 加密为 `enc:v1:<salt>:<iv>:<tag>:<密文>`，写入 `config.json`（`600`） |
| 主密钥 | `data/secrets.key`（`600`），或环境变量 `CODEX_WEB_SECRET_KEY` |
| 展示 | 只返回 `sk-****d00a` 形式的脱敏值（`apiKeyMask`） |
| 使用 | 解密后仅注入子进程环境变量，Codex 通过 `env_key` 读取 |
| 日志/审计 | 只记录供应商 ID 与模型名，从不记录密钥 |
| 备份 | `config.json` + `data/secrets.key` 必须一起备份 |

轮换密钥：在网页里重新填写，或 `node model-admin.js set-key <id> <新密钥>`，保存后立即生效，
不需要重启服务（当前正在运行的任务仍使用旧密钥）。

## 8. 常见问题

**Q：可以同时配置多个供应商吗？**
可以。`active` 决定默认供应商；模型下拉框会列出所有供应商的模型，选中的模型会自动路由到所属供应商。

**Q：不配置任何供应商会怎样？**
Codex 会退回使用 `~/.codex/config.toml` 里的模型与登录态（`model` 字段也可以作为兜底默认模型）。

**Q：Codex Web 会不会改动我的 `~/.codex/config.toml`？**
不会，除非你显式执行 `node model-admin.js import --strip`。

**Q：网页里的「测试连接」失败但任务能跑？**
有些服务不提供 `/models` 接口，`404` 属于正常（页面会提示「该服务没有 /models 接口」）。
