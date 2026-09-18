# 权限模型与安全

Codex Web 的权限分三层，彼此独立又叠加生效：

| 层 | 位置 | 作用 |
| --- | --- | --- |
| 账号权限 | `config.json` → `users[].permissions` | 谁能登录、能用哪些功能、沙箱上限、默认工作目录 |
| 本机权限策略 | `config.json` → `policy` | 对**所有账号**生效的机器级护栏：工作目录、命令黑名单、受保护路径、超时、联网、并发、审计 |
| Codex 自身沙箱 | 每次任务的 `--sandbox` | `read-only` / `workspace-write` / `danger-full-access`，由 Codex 在系统调用层面限制 |

## 1. 账号权限

| 权限 | 作用 |
| --- | --- |
| 提交任务 | 能否使用 Codex 执行任务；关闭后只能浏览界面 |
| 浏览目录 | 能否在工作中使用目录选择器；关闭后只能在默认工作目录里运行 |
| 查看自己的会话 | 是否显示自己的历史会话 |
| 查看他人会话 | 能否看到其他成员的会话（管理员默认开启） |
| 管理账号 | 能否打开账号/模型/权限管理页（仅管理员角色会拥有） |
| 权限上限 | 该账号能选到的最高沙箱，超出会自动降级 |
| 默认工作目录 | 新建任务时的默认目录，也是没有浏览权限时唯一可用的目录 |

角色：`admin` 自动拥有全部权限（不能被单独取消）；`member` 按逐项权限运行，默认只能看自己的会话。
系统始终保证至少有一个可用管理员，且不能删除/禁用/降级自己。

## 2. 本机权限策略

| 策略项 | 生效时机 | 说明 |
| --- | --- | --- |
| 允许的工作目录 `allowedRoots` | 任务提交时 | 工作目录不在其中直接返回 403，不会启动 Codex |
| 目录浏览范围 `browseRoots` | 浏览目录时 | 留空则沿用 `allowedRoots`；两者都为空表示不限制 |
| 禁止执行的命令 `denyCommands` | 事件流实时 | 每条是一个正则，命中 `command_execution` 的命令即**立即终止**任务 |
| 受保护路径 `protectPaths` | 事件流实时 | 文件变更命中这些路径前缀即终止任务 |
| 单任务最长运行 `maxRunMinutes` | 任务运行中 | 超时自动终止（0 = 不限） |
| 允许 Workspace 沙箱联网 `allowNetwork` | 任务启动时 | 关闭时传 `-c sandbox_workspace_write.network_access=false` |
| 审计 `audit` | 任务结束 | 追加一条 JSON 记录到 `data/audit.jsonl` |
| 并发上限 | 任务提交时 | 全局 / 单账号同时运行的任务数 |

默认的禁止命令与受保护路径见 `lib/store.js` 里的 `DEFAULT_DENY_COMMANDS` / `DEFAULT_PROTECT_PATHS`：

```text
rm -rf /、mkfs、dd of=/dev/sdX、> /dev/sdX、shutdown/reboot/halt、fork 炸弹、chmod -R 777 /
/etc /boot /dev /proc /sys /root/.ssh /root/.codex /root/.gnupg
```

在网页 **设置 → 本机权限与审计** 里可以逐条增删；正则写错只会被跳过，不会让服务崩溃。

### 审计日志

每次任务结束（完成、失败、被拦截、超时）都会追加一行 JSON：

```json
{
  "at": "2026-09-18T05:20:11.482Z",
  "runId": "6f1c…",
  "user": "alice",
  "cwd": "/srv/project",
  "sandbox": "workspace-write",
  "model": "deepseek-chat",
  "provider": "deepseek",
  "threadId": "01a0…",
  "prompt": "给登录页加上错误提示",
  "exitCode": 0,
  "signal": "",
  "durationMs": 48213,
  "blockedReason": "",
  "violations": []
}
```

被拦截时 `blockedReason` 为 `policy` 或 `timeout`，`violations` 里记录命中的规则与命令片段。
接口 `GET /api/admin/audit?limit=100` 返回最近记录（网页里也能直接看）。

## 3. 这些护栏能做什么、不能做什么

**能做**

- 阻止明显的误操作（`rm -rf /`、写块设备、改 `/etc`、动 SSH 密钥）；
- 把 Agent 的活动范围限制在指定目录；
- 出事后能追溯：谁、什么时候、在哪个目录、用什么模型、跑了什么任务、结果如何；
- 限制单任务时长与并发，避免一台机器被跑满。

**不能做**

- **不是操作系统级隔离**：`danger-full-access` 的账号仍然能读写这台机器上的任何文件，
  命令黑名单只是正则匹配，聪明（或恶意）的模型可以绕过；
- 受保护路径是在**检测到文件变更事件后**终止任务，不保证变更没有落盘；
  真正禁止写入请用 `read-only` / `workspace-write` 或容器挂载只读；
- 网络限制只在 `workspace-write` 沙箱下有意义，`danger-full-access` 时不受约束；
- 服务本身以运行用户的身份工作，账号密码泄露即等于该用户身份的代码执行能力。

## 4. 加固清单

1. **不要直接暴露端口**：只经 nginx/HTTPS，必要时加 IP 白名单、Basic Auth、fail2ban 或 SSO；
2. **最小权限**：给成员 `read-only` 或 `workspace-write`，并把「允许的工作目录」限定到具体项目目录；
3. **专用用户**：用 `useradd -m -s /bin/bash codex` 建专用用户跑服务，只给它需要的工作目录权限；
4. **保护敏感文件**：`chmod 600 config.json data/secrets.key data/audit.jsonl`；不要把 `data/` 放进网站目录；
5. **容器化**：`docker run` 时只挂载工作目录，加 `--read-only`、`--cap-drop=ALL`、`--pids-limit`、`--memory`；
6. **定期审计**：在网页里或 `cat data/audit.jsonl | tail -50` 检查异常任务；
7. **密钥治理**：用 `CODEX_WEB_SECRET_KEY` 通过 systemd `Environment=` / Docker Secret 提供加密主密钥，
   与配置文件分开存放；
8. **升级**：及时跟进 Codex CLI 与项目的更新，升级前在测试账号上验证。

## 5. 上报安全问题

请不要在公开 Issue 里贴出可利用细节，按 [SECURITY.md](../SECURITY.md) 的方式私下联系维护者。
