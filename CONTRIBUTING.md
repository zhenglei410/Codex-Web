# 贡献指南

感谢你愿意改进 Codex Web！

## 开发环境

```bash
git clone https://github.com/<你的账号>/codex-web.git
cd codex-web
cp config.example.json config.json          # 本地开发用配置
node user-admin.js add admin 'test-password' --admin
node server.js                              # http://127.0.0.1:8790
```

项目没有构建步骤、没有 npm 依赖，改完 `server.js` 重启进程即可；`public/` 里的前端资源改完刷新浏览器。

## 提交前自检

```bash
node --check server.js
node --check lib/store.js && node --check lib/secrets.js
node --check user-admin.js && node --check model-admin.js
bash scripts/smoke-test.sh                  # 不需要真实 API Key，会校验加密、脱敏与权限拦截
npm install && npm run test:ui              # 前端行为测试（需要 jsdom，仅开发依赖）
```

## 代码约定

- 后端只用 Node 内置模块（`node:http`、`node:fs`、`node:crypto`…），**不要引入运行时依赖**；
- 配置结构统一放在 `lib/store.js` 里规范化，`server.js`、`user-admin.js`、`model-admin.js` 共用；
- 涉及密钥的代码必须保证：明文不落盘、不进程命令行参数、不进日志与接口响应；
- 注释与界面文案使用中文，保持与现有风格一致；
- 新功能请同时更新 README 与 `docs/` 下对应文档。

## Pull Request

1. 一个 PR 只做一件事，标题写清楚动机；
2. 说明改动原因、验证方式（命令与结果）；
3. 涉及权限/安全的改动请特别说明边界与绕过风险；
4. 保持向后兼容：`config.json` 的新字段要有默认值，旧配置要能自动迁移。

## 报告 Issue

- 功能建议：说明使用场景与你期望的交互；
- Bug：附上系统版本、`node -v`、`codex --version`、复现步骤，以及 `journalctl -u codex-web -n 50`
  或终端输出（**请先去掉 API Key、密码等敏感信息**）。
