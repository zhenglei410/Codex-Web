# Codex Web

把本机 **Codex CLI** 变成多人可用的 Web 工作台：在浏览器里选模型、下达任务、实时看到命令输出与文件变更；
管理员集中管理模型供应商与 API Key（**加密保存、界面脱敏**）、账号权限，以及 Codex 在本机上的操作边界。

> 零运行时依赖：只需要 Node.js ≥ 20 和本机的 `codex` 可执行文件。

[English](README.en.md) · [部署文档](docs/deployment.md) · [模型配置](docs/models.md) · [权限与安全](docs/permissions.md)

---

## 功能特性

| 特性 | 说明 |
| --- | --- |
| 浏览器驱动 Codex | 后端把 `codex exec --json` 的 JSONL 事件转成 SSE，前端渲染成对话气泡、命令行卡片（含输出与退出码）、文件变更列表与 token 用量 |
| 多模型供应商 | 在网页里添加任意 OpenAI 兼容供应商（DeepSeek、OpenAI、通义、智谱、Moonshot、Ollama、vLLM…），右上角随时切换本次任务用的大模型 |
| API Key 脱敏保存 | 密钥以 AES-256-GCM 密文写入 `config.json`，界面与接口只返回 `sk-****d00a`；运行时只通过子进程**环境变量**注入，命令行参数、日志、审计记录里都不会出现明文 |
| 多账号与角色 | 管理员 / 成员两种角色，逐项权限（提交任务、浏览目录、查看会话、管理账号…），每个账号可单独设工作目录与沙箱上限；支持「首次登录必须改密码」 |
| 本机权限控制 | 管理员可限制 Codex 能进哪些目录、禁止哪些命令、不能写哪些路径，并设置单任务超时、联网开关、并发上限；命中即实时终止任务并留下审计记录 |
| 会话与审计 | 会话归属按账号隔离（成员只看自己的）；每次任务都有审计日志（谁、在哪、用什么模型、结果如何、是否被拦截） |
| 零依赖部署 | 后端只用 Node 内置模块，无 npm 依赖；提供 systemd、nginx、Docker 等多种部署方式 |

## 架构

```
浏览器 ──HTTPS──> nginx ──HTTP──> 127.0.0.1:8790 (server.js)
                                        │
                                        ├─ spawn ─> codex exec --json [--model …] [-c model_providers.*] …
                                        │                 ▲
                                        │                 └─ API Key 只经环境变量注入（不出现在 argv / 日志）
                                        └─ 读取 ──> $CODEX_HOME/sessions/**/*.jsonl（历史会话）
```

| 文件 | 说明 |
| --- | --- |
| `server.js` | Node.js 后端（零依赖）：登录鉴权、模型供应商、本机权限策略、SSE 事件流、进程管理、目录浏览、审计日志 |
| `public/` | 前端单页应用：会话列表、对话区、模型/沙箱选择、设置、模型与 API Key、本机权限与审计 |
| `lib/store.js` | `config.json` 的读写与规范化（`server.js`、`user-admin.js`、`model-admin.js` 共用） |
| `lib/secrets.js` | API Key 的加密（AES-256-GCM）、解密与脱敏 |
| `config.json` | 运行配置（端口、账号、模型供应商、本机权限策略、Codex 路径…），权限 `600` |
| `data/secrets.key` | API Key 加密主密钥（权限 `600`）；也可以用环境变量 `CODEX_WEB_SECRET_KEY` 代替 |
| `data/thread-owners.json` | 会话归属（哪个会话由哪个账号发起） |
| `data/audit.jsonl` | 审计日志（每次任务的目录、模型、结果、是否被策略拦截） |
| `user-admin.js` / `model-admin.js` | 账号 / 模型供应商的命令行管理工具（没有管理员可登录时的兜底手段） |
| `deploy/` | systemd 服务单元与 nginx 反代示例 |
| `scripts/smoke-test.sh` | 冒烟测试：在隔离实例里验证登录、密钥加密脱敏、权限拦截与审计 |

## 快速开始

### 1. 安装 Codex CLI

```bash
# 方式一：npm（需要 Node.js ≥ 20）
npm install -g @openai/codex

# 方式二：Homebrew（macOS / Linux）
brew install codex

# 方式三：下载官方二进制（https://github.com/openai/codex/releases）
```

安装完可以先跑一次确认 CLI 本身可用：

```bash
codex login          # 用 ChatGPT 账号登录（可选）
codex --version
```

> 如果你打算用 DeepSeek 之类的第三方 API，**可以完全不登录 ChatGPT**：
> 在 Codex Web 里配置供应商 + API Key 即可，服务会在每次运行任务时把密钥注入子进程。
> 各系统（Debian/Ubuntu、CentOS/Rocky、macOS、Windows WSL2）的安装细节见 [docs/deployment.md](docs/deployment.md)。

### 2. 安装 Node.js ≥ 20

```bash
# Ubuntu / Debian
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

# macOS
brew install node

node -v   # 需要 ≥ 20
```

### 3. 获取本项目

```bash
git clone https://github.com/<你的账号>/codex-web.git
cd codex-web
bash scripts/smoke-test.sh   # 可选：确认功能正常（不需要真实 API Key）
```

### 4. 初始化配置

```bash
cp config.example.json config.json
# 生成会话密钥（务必替换掉示例值）
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
# 把输出填进 config.json 的 sessionSecret 即可
```

### 5. 启动

```bash
node server.js          # 默认监听 127.0.0.1:8790
```

浏览器打开 `http://127.0.0.1:8790`，用**默认账号 `admin` / 默认密码 `admin`** 登录。
首次登录会被强制要求设置新密码（至少 8 位），改完才能使用其他功能。

生产环境建议用 systemd + nginx：

```bash
sudo bash scripts/install.sh    # 安装到 /opt/codex-web 并注册 systemd 服务
sudo systemctl status codex-web
```

> 默认口令是公开的：**改密之前不要把服务暴露到公网**。想跳过强制改密、直接设置初始密码，可以执行
> `node user-admin.js passwd admin '你的强密码'`（再加 `--force-change` 表示下次登录仍要求改密）。

nginx 反代与 HTTPS 证书的完整步骤见 [docs/deployment.md](docs/deployment.md)。

## 模型与 API Key

登录后点左下角 **设置 → 模型与 API Key**（管理员可见）：

| 字段 | 说明 |
| --- | --- |
| 供应商 ID | 小写字母/数字/短横线，用于生成 `-c model_providers.<id>.*` 覆盖项，例如 `deepseek` |
| 显示名称 | 下拉框里展示的名字，例如 `DeepSeek` |
| API Base URL | 例如 `https://api.deepseek.com`、`https://api.openai.com/v1` |
| 接口类型 | `responses`（Codex / OpenAI Responses 兼容）或 `chat`（Chat Completions 兼容） |
| 密钥环境变量名 | 注入密钥时使用的环境变量名，默认 `<ID>_API_KEY` |
| 模型列表 | 该供应商可选的模型，例如 `deepseek-chat, deepseek-reasoner` |
| 模型目录文件 | 可选，对应 Codex 的 `model_catalog_json`，用于补充模型元数据 |

保存后右上角即可切换模型。「测试连接」会请求一次 `${baseUrl}/models` 验证地址与密钥，不消耗 token。

**密钥是怎么保存的**

- 明文只在提交表单的那一次请求里出现，落盘前就被 AES-256-GCM 加密成 `enc:v1:<salt>:<iv>:<tag>:<密文>`；
- 加密主密钥保存在 `data/secrets.key`（`600`），也可以用 `CODEX_WEB_SECRET_KEY` 环境变量提供，
  因此只泄露 `config.json`（例如仓库里的配置样例、误传的备份）不足以还原密钥；
- 界面、接口、日志、审计记录里一律只出现 `sk-****d00a` 这样的脱敏值；
- 运行任务时服务把密钥解密后放进**子进程环境变量**，配合 Codex 的 `env_key` 机制使用 ——
  `ps` 看不到，也不会写进 `~/.codex/config.toml`；
- `data/secrets.key` 请与 `config.json` 一起备份；丢失后已保存的密钥无法解密，需要重新填写。

**命令行方式**（适合脚本化部署，等价于网页管理）：

```bash
node model-admin.js list
node model-admin.js add deepseek --name DeepSeek --base-url https://api.deepseek.com \
  --wire-api responses --models deepseek-chat,deepseek-reasoner --key sk-xxxx --activate
node model-admin.js add openai --name OpenAI --base-url https://api.openai.com/v1 \
  --wire-api responses --models gpt-5-codex --key-env OPENAI_API_KEY
node model-admin.js set-key deepseek sk-新密钥
node model-admin.js test deepseek
node model-admin.js import --strip   # 从 ~/.codex/config.toml 导入现有供应商（含明文密钥）并清理明文
```

常见供应商的填写示例（DeepSeek / OpenAI / 通义千问 / 智谱 / Moonshot / Ollama / vLLM）见
[docs/models.md](docs/models.md)。

## 本机权限控制

管理员在 **设置 → 本机权限与审计** 里配置，规则对**所有账号**生效：

| 策略项 | 作用 | 默认值 |
| --- | --- | --- |
| 启用本机权限策略 | 总开关；关闭后除账号权限外不再有额外限制 | 启用 |
| 允许的工作目录 | Codex 只能在列出的目录（含子目录）里工作，越界直接拒绝 | 不限制 |
| 目录浏览范围 | 网页目录选择器能浏览的范围 | 同「允许的工作目录」 |
| 禁止执行的命令 | 每行一条正则，命中即**立即终止**该任务 | 内置 `rm -rf /`、`mkfs`、写块设备、`shutdown` 等 |
| 受保护路径 | 每行一个路径前缀，发生文件变更即终止任务 | `/etc`、`/boot`、`/dev`、`/proc`、`/sys`、`/root/.ssh`、`/root/.codex` 等 |
| 单任务最长运行 | 超时自动终止（分钟，0 = 不限） | 不限 |
| 允许 Workspace 沙箱联网 | `workspace-write` 模式下是否允许联网（`-c sandbox_workspace_write.network_access`） | 允许 |
| 记录审计日志 | 每次任务写入 `data/audit.jsonl` | 开启 |
| 并发上限 | 全局 / 单账号同时运行的任务数 | 3 / 2 |

被拦截的任务会在对话里出现红色提示，并在审计列表里记为「被策略拦截」或「超时终止」。

> **请记住这是产品层面的护栏，不是操作系统级隔离。**
> `danger-full-access` 仍然等于把这台机器交给对方；要真正隔离，请把 Codex Web 放进容器或虚拟机，
> 只挂载需要被 Agent 操作的工作目录、去掉多余的能力。细节见 [docs/permissions.md](docs/permissions.md)。

## 多账号与权限

账号管理在 **设置 → 账号与权限管理**（管理员可见），也可以在命令行用 `user-admin.js` 维护：

```bash
node user-admin.js list
node user-admin.js add alice '至少8位密码' --name 爱丽丝 --sandbox read-only --cwd /srv/project
node user-admin.js passwd alice '新密码'
node user-admin.js disable alice
```

角色：

| 角色 | 说明 |
| --- | --- |
| `admin` 管理员 | 自动拥有全部权限；不能删除/禁用/降级最后一个管理员，也不能删除或禁用自己 |
| `member` 成员 | 按逐项权限运行，默认只能看到自己的会话 |

逐项权限：提交任务、浏览目录、查看自己的会话、查看他人会话、管理账号、权限上限（可选的最高沙箱）、默认工作目录。
成员选择的沙箱超出上限时会自动降级到上限，而不是直接失败。

「首次登录需改密码」：网页新增账号时默认勾选（命令行加 `--must-change`），管理员重置他人密码后也会自动勾上。
处于该状态的账号在改密前只能访问登录、退出、改密接口，其余接口一律返回 403，界面会自动弹出改密窗口。

## 配置项（config.json）

| 字段 | 含义 |
| --- | --- |
| `host` / `port` | 监听地址与端口，默认 `127.0.0.1:8790`（只经 nginx 对外） |
| `users` | 账号数组：`username` / `displayName` / `passwordHash` / `role` / `disabled` / `sessionVersion` / `mustChangePassword` / `permissions` |
| `sessionSecret` | 会话 Cookie 的 HMAC 密钥，泄露等于可伪造登录 |
| `sessionTtlHours` | 登录有效期（小时） |
| `codexBin` / `codexHome` | Codex 可执行文件与 `CODEX_HOME` 配置目录 |
| `defaultCwd` | 没有单独设置工作目录时的兜底目录 |
| `sandbox` | 默认沙箱：`read-only` / `workspace-write` / `danger-full-access` |
| `model` | 兜底默认模型（留空表示用供应商默认模型或 Codex 自身配置） |
| `models` | 模型供应商：`active`（默认供应商）+ `providers[]`（含加密后的 `apiKeyEnc`） |
| `policy` | 本机权限策略（见上一节） |
| `maxConcurrentRuns` / `maxConcurrentRunsPerUser` | 全局 / 单账号并发上限 |

环境变量：

| 变量 | 作用 |
| --- | --- |
| `CODEX_WEB_CONFIG` | 指定 `config.json` 路径（默认脚本同级目录） |
| `CODEX_WEB_DATA_DIR` | 指定数据目录（密钥文件、审计日志，默认 `./data`） |
| `CODEX_WEB_SECRET_KEY` | 覆盖 API Key 加密主密钥（适合交给系统密钥管理） |
| `<供应商 env_key>` | 例如 `DEEPSEEK_API_KEY`：不在网页里保存密钥时，从环境变量读取 |

## HTTP 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/login`、`/api/logout` | 登录 / 退出，成功后下发 HttpOnly 会话 Cookie |
| POST | `/api/password` | 修改自己的密码（会让本账号其他设备下线） |
| GET | `/api/session` | 当前登录信息、权限、可选模型、生效策略 |
| GET | `/api/models` | 可选的模型列表（登录即可） |
| POST | `/api/run` | 提交任务，返回 SSE 事件流（`run.started` / `item.*` / `policy.blocked` / `run.exited` …） |
| POST | `/api/stop` | 停止指定 `runId` 的任务 |
| GET | `/api/threads`、`/api/threads/:id` | 历史会话列表 / 单个会话消息 |
| GET | `/api/fs?path=` | 目录浏览（受「目录浏览范围」限制） |
| GET/POST | `/api/admin/users`、POST `/api/admin/users/:name`、`/:name/delete` | 账号列表、新增、改权限、重置密码、强制下线、删除 |
| GET/POST | `/api/admin/models` | 模型供应商列表 / 新增或更新（含 API Key） |
| POST | `/api/admin/models/:id/activate`、`/test`、`/clear-key`、`/delete` | 设为默认、测试连通性、清除密钥、删除 |
| GET/POST | `/api/admin/policy` | 读取 / 保存本机权限策略与并发上限 |
| GET | `/api/admin/audit?limit=` | 审计日志 |

## 安全须知

1. 服务以运行它的用户（通常是 `root`）身份工作，**能登录的人就能操作这台机器**；
2. 不要把 8790 端口直接暴露到公网，只经 nginx/HTTPS 反代，必要时再加 IP 白名单、fail2ban 或 SSO；
3. 给成员账号只开必要权限，优先 `read-only` / `workspace-write`，并在「本机权限」里限制工作目录与命令；
4. 使用强密码并定期更换；`config.json`、`data/secrets.key`、`data/audit.jsonl` 权限保持 `600`；
5. 升级 Codex CLI 后建议先在测试账号上验证，谨慎使用 `danger-full-access`；
6. 详细的威胁模型与加固清单见 [docs/permissions.md](docs/permissions.md) 与 [SECURITY.md](SECURITY.md)。

## 常见问题

**Q：没有 ChatGPT 账号能用吗？**
能。配置一个 OpenAI 兼容供应商（如 DeepSeek）并填 API Key 即可，运行时密钥只注入子进程环境变量。

**Q：为什么任务报 `Model metadata for ... not found`？**
该模型不在 Codex 内置元数据里。可以在供应商里指定「模型目录文件」（`model_catalog_json`），
或忽略这条提示（Codex 会使用兜底元数据，可能影响上下文长度等参数）。

**Q：任务报 401 / Authentication Fails？**
检查 API Key、Base URL 是否与接口类型匹配（`responses` 对应 `/responses`，`chat` 对应 `/chat/completions`），
以及供应商是否支持所选接口。用「测试连接」可以快速排除地址问题。

**Q：改了 `config.json` 需要重启吗？**
网页里的操作立即生效；手工编辑文件后需要重启服务（`systemctl restart codex-web`）。

**Q：会话记录存在哪里？**
Codex CLI 自己的 `$CODEX_HOME/sessions/**/*.jsonl`；Codex Web 只额外记录会话归属与审计日志。

**Q：怎么升级？**

```bash
cd codex-web && git pull
sudo systemctl restart codex-web     # 或 docker compose up -d --build
```

`config.json` 会在启动时自动补齐新增字段并保持兼容（旧版单账号配置会自动迁移为多账号）。

## 参与贡献

欢迎提交 Issue 与 PR，见 [CONTRIBUTING.md](CONTRIBUTING.md)。提交前请先跑一遍：

```bash
bash scripts/smoke-test.sh
```

## 许可证

[MIT](LICENSE)
