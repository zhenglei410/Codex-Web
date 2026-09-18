# 更新日志

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [1.1.0] - 2026-09-18

### 新增

- **首次部署即用**：默认管理员账号与密码均为 `admin`，首次登录会**强制要求修改密码**
  （改密前后端会拦下除登录/退出/改密以外的所有接口）；新增账号可勾选「首次登录需改密码」，
  管理员重置他人密码后也会自动要求对方改密；`user-admin.js` 新增 `--must-change` / `--force-change`；
- **模型供应商管理**：网页「设置 → 模型与 API Key」与命令行 `model-admin.js` 可以添加任意 OpenAI
  兼容供应商（DeepSeek、OpenAI、通义、智谱、Ollama…），右上角按任务切换模型；
- **API Key 脱敏保存**：密钥以 AES-256-GCM 密文写入 `config.json`，界面/接口/日志只出现
  `sk-****d00a`；运行时只通过子进程环境变量注入（配合 Codex 的 `env_key`），不改动 `~/.codex/config.toml`；
- **本机权限控制**：允许的工作目录、禁止执行的命令、受保护路径、单任务超时、Workspace 沙箱联网开关、
  并发上限；命中策略立即终止任务并在界面上提示；
- **审计日志**：每次任务记录账号、目录、模型、供应商、耗时、退出码与拦截原因，网页可查看；
- **命令行工具**：`model-admin.js`（list/add/set-key/clear-key/activate/test/remove/import），
  支持从 `~/.codex/config.toml` 导入现有供应商及明文密钥（`--strip` 可清理明文）；
- **文档**：重写 README，新增 `docs/deployment.md`（各系统部署与 Codex 安装）、
  `docs/models.md`、`docs/permissions.md`、`README.en.md`、`SECURITY.md`、`CONTRIBUTING.md`、
  MIT `LICENSE`、`Dockerfile` / `docker-compose.yml`、`scripts/install.sh`；
- **冒烟测试**：`scripts/smoke-test.sh`（23 项断言，覆盖加密、脱敏、策略拦截与审计，不需要真实密钥）。

### 变更

- `config.json` 新增 `models` 与 `policy` 两段配置，启动时自动补齐，旧配置无需手工迁移；
- 配置读写与规范化集中到 `lib/store.js`，避免网页端与命令行工具互相覆盖字段；
- 会话密钥 `sessionSecret` 缺失时自动生成并写回，不再每次重启都让登录态失效。

## [1.0.0] - 2026-09-17

- 首个版本：浏览器驱动本机 Codex CLI，多账号与逐项权限、会话归属隔离、SSE 事件流、目录选择器、
  nginx + systemd 部署。
