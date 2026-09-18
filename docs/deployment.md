# 部署指南

本文覆盖：Codex CLI 在各系统的安装、Codex Web 的 systemd / Docker / macOS / WSL2 部署方式、
nginx + HTTPS 反代、升级与备份。

目录

- [0. 部署前确认](#0-部署前确认)
- [1. 安装 Codex CLI](#1-安装-codex-cli)
- [2. 安装 Node.js](#2-安装-nodejs)
- [3. Linux + systemd（推荐）](#3-linux--systemd推荐)
- [4. nginx + HTTPS 反代](#4-nginx--https-反代)
- [5. Docker / Docker Compose](#5-docker--docker-compose)
- [6. macOS](#6-macos)
- [7. Windows（WSL2）](#7-windowswsl2)
- [8. 宝塔面板（BT Panel）](#8-宝塔面板bt-panel)
- [9. 升级、备份与卸载](#9-升级备份与卸载)
- [10. 故障排查](#10-故障排查)

## 0. 部署前确认

| 项目 | 要求 |
| --- | --- |
| 操作系统 | Linux（Debian/Ubuntu/CentOS/Rocky/Alpine）、macOS 13+、Windows 11 + WSL2 |
| Node.js | ≥ 20（推荐 22 LTS），项目本身**没有任何 npm 依赖** |
| Codex CLI | `codex --version` 能正常输出 |
| 权限 | 服务以谁的身份运行，Codex 就以谁的身份操作机器；建议用专用用户，别用 root |
| 网络 | 至少需要能访问你选择的模型服务；对外只暴露 nginx 的 443 |

先跑一次冒烟测试确认程序本身没问题（不需要真实 API Key）：

```bash
bash scripts/smoke-test.sh
```

## 1. 安装 Codex CLI

### 1.1 通用（npm）

```bash
npm install -g @openai/codex
codex --version
```

Linux 上如果 npm 的全局 bin 目录不在 `PATH`，按提示把它加进去，或改用下面的官方安装脚本。

### 1.2 官方安装脚本（Linux / macOS）

```bash
curl -fsSL https://github.com/openai/codex/releases/latest/download/install.sh | bash
```

### 1.3 Homebrew（macOS / Linuxbrew）

```bash
brew install codex
```

### 1.4 手动下载二进制

到 <https://github.com/openai/codex/releases> 下载对应平台的压缩包，解压后把 `codex`
放到 `PATH` 里（例如 `/usr/local/bin/codex`）：

```bash
chmod +x codex && sudo mv codex /usr/local/bin/codex
codex --version
```

### 1.5 登录方式

```bash
codex login                 # ChatGPT 账号登录（会写入 ~/.codex/auth.json）
# 或者完全不用 ChatGPT：在 Codex Web 里配置第三方 API Key，见 docs/models.md
```

服务运行时使用 `CODEX_HOME` 指向的配置目录（默认 `~/.codex`）。如果你希望 Codex Web
使用独立的 Codex 配置目录（例如系统服务用户家目录里的），在 `config.json` 里改 `codexHome`。

## 2. 安装 Node.js

### Debian / Ubuntu

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node -v
```

### CentOS / Rocky / RHEL / AlmaLinux

```bash
curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo bash -
sudo dnf install -y nodejs
node -v
```

### Alpine

```bash
apk add --no-cache nodejs npm
```

### macOS

```bash
brew install node
```

### Windows（在 WSL2 里）

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
```

## 3. Linux + systemd（推荐）

### 3.1 一键安装脚本

```bash
git clone https://github.com/<你的账号>/codex-web.git
cd codex-web
sudo bash scripts/install.sh            # 默认装到 /opt/codex-web，注册并启动 codex-web.service
```

脚本会：复制程序到目标目录、生成 `config.json`（随机 `sessionSecret`）、创建数据目录并收紧权限、
生成 systemd unit、启动服务。

可选参数：

```bash
sudo bash scripts/install.sh --dir /srv/codex-web --user www-data --port 8790
```

安装完成后立刻补上管理员账号：

```bash
sudo -u <运行用户> node /opt/codex-web/user-admin.js add admin '强密码' --admin
sudo systemctl restart codex-web
```

### 3.2 手工安装

```bash
sudo mkdir -p /opt/codex-web && sudo cp -r . /opt/codex-web/
cd /opt/codex-web
sudo cp config.example.json config.json
sudo node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # 写入 sessionSecret
sudo node user-admin.js add admin '强密码' --admin
sudo cp deploy/codex-web.service /etc/systemd/system/codex-web.service
sudo systemctl daemon-reload && sudo systemctl enable --now codex-web
```

### 3.3 systemd 单元要点

`deploy/codex-web.service` 里的占位符：

| 占位符 | 说明 |
| --- | --- |
| `__APP_DIR__` | 程序目录，例如 `/opt/codex-web` |
| `__NODE_BIN__` | node 可执行文件绝对路径（`command -v node`） |
| `__RUN_USER__` | 运行用户，建议专用用户；用 root 才能让 Codex 操作系统级路径 |

加固建议（按需启用）：

```ini
[Service]
NoNewPrivileges=true
ProtectSystem=full
ProtectHome=read-only
PrivateTmp=true
ReadWritePaths=/opt/codex-web/data /srv/projects
```

注意：这些限制会同时限制 Codex 子进程的能力，请先确认你的工作目录都在 `ReadWritePaths` 里。

### 3.4 常用命令

```bash
systemctl status codex-web
journalctl -u codex-web -f          # 实时日志
systemctl restart codex-web
```

## 4. nginx + HTTPS 反代

参考 `deploy/nginx.conf.example`。核心是把请求反代到 `127.0.0.1:8790`，并关闭缓冲以支持 SSE：

```nginx
location / {
    proxy_pass http://127.0.0.1:8790;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
}
```

证书用 certbot：

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d codex.example.com
```

或者用 acme.sh：

```bash
acme.sh --issue -d codex.example.com --webroot /var/www/codex-web
acme.sh --install-cert -d codex.example.com \
  --key-file /etc/nginx/ssl/codex.example.com.key \
  --fullchain-file /etc/nginx/ssl/codex.example.com.pem \
  --reloadcmd "systemctl reload nginx"
```

访问控制建议：

- 不要在防火墙里开放 8790；
- nginx 层可加 IP 白名单：`allow 1.2.3.4; deny all;`；
- 或者加一层 Basic Auth（`auth_basic`）做双保险；
- 公网暴露时建议再加 fail2ban 规则，监控 `/api/login` 的 401/429。

## 5. Docker / Docker Compose

容器方式适合做「真正的隔离」：把工作目录挂进去，Codex 只能操作挂载进来的路径。

```bash
docker build -t codex-web .
docker run -d --name codex-web \
  -p 127.0.0.1:8790:8790 \
  -e CODEX_WEB_SECRET_KEY="$(openssl rand -hex 32)" \
  -v "$PWD/config.json:/app/config.json" \
  -v "$PWD/data:/app/data" \
  -v "/srv/projects:/workspace" \
  codex-web
```

`docker-compose.yml` 已经准备好，直接：

```bash
docker compose up -d --build
docker compose exec codex-web node user-admin.js add admin '强密码' --admin
docker compose exec codex-web node model-admin.js add deepseek --name DeepSeek \
  --base-url https://api.deepseek.com --wire-api responses \
  --models deepseek-chat,deepseek-reasoner --key sk-xxxx --activate
```

容器里的要点：

- Codex CLI 需要容器内可用（Dockerfile 里已经用 npm 安装）；重新构建即可升级；
- 用 `CODEX_WEB_SECRET_KEY` 提供加密主密钥，就不必把 `data/secrets.key` 放进镜像卷；
- 想让 Codex 用 ChatGPT 账号登录，把宿主机的 `~/.codex` 挂到容器的 `/home/node/.codex`，
  然后 `docker compose exec codex-web codex login`；
- 挂载的工作目录会出现在容器内的路径（如 `/workspace`），在网页里选择该路径即可。

## 6. macOS

```bash
brew install node codex
git clone https://github.com/<你的账号>/codex-web.git && cd codex-web
cp config.example.json config.json
node user-admin.js add admin '强密码' --admin
node server.js
```

做成开机自启（launchd）：

```bash
sudo tee /Library/LaunchDaemons/com.codex-web.plist >/dev/null <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.codex-web</string>
  <key>ProgramArguments</key>
  <array><string>/opt/homebrew/bin/node</string><string>/Users/Shared/codex-web/server.js</string></array>
  <key>WorkingDirectory</key><string>/Users/Shared/codex-web</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>EnvironmentVariables</key>
  <dict><key>CODEX_HOME</key><string>/Users/你的用户名/.codex</string></dict>
</dict></plist>
PLIST
sudo launchctl load -w /Library/LaunchDaemons/com.codex-web.plist
```

macOS 没有 systemd 的沙箱能力，本机权限控制（工作目录、命令黑名单、受保护路径）就更重要，
建议在网页 **设置 → 本机权限** 里明确限定工作目录。

## 7. Windows（WSL2）

Codex CLI 与 Codex Web 都跑在 WSL2 的 Linux 发行版里，浏览器用 Windows 侧的即可。

```powershell
wsl --install -d Ubuntu
```

进入 Ubuntu 后按 [第 2 节](#2-安装-nodejs) 安装 Node，再按 [第 3 节](#3-linux--systemd推荐) 部署。
WSL2 默认支持 systemd（Ubuntu 22.04+，若没有可在 `/etc/wsl.conf` 里加 `[boot] systemd=true`）。

几点注意：

- 文件放 Linux 侧文件系统（`~/codex-web`）性能更好，跨 `/mnt/c/...` 操作会很慢；
- 想让 Codex 操作 Windows 上的目录，用 `/mnt/c/Users/you/project` 作为工作目录，
  并在「本机权限」里把该路径加入允许的工作目录；
- 用 Windows 计划任务或 `wsl.exe -d Ubuntu -u root -e systemctl start codex-web` 做开机启动；
- 端口默认只监听 `127.0.0.1`，Windows 侧浏览器可以直接访问 `http://127.0.0.1:8790`。

## 8. 宝塔面板（BT Panel）

1. **软件商店** 安装 Node.js 版本管理器（Node ≥ 20）与 nginx；
2. 把项目上传/克隆到网站目录之外，例如 `/www/server/codex-web`
   （避免宝塔的站点权限策略把 `config.json` 改成 `www:www 644` 而泄露会话密钥）；
3. 生成配置与账号：

   ```bash
   cd /www/server/codex-web
   cp config.example.json config.json
   node user-admin.js add admin '强密码' --admin
   ```

4. 在 **网站 → 添加站点** 里创建站点（只作为证书校验的 webroot），然后编辑 nginx 配置，
   把 `location /` 反代到 `http://127.0.0.1:8790`（参考 `deploy/nginx.conf.example`）；
5. 用面板申请 Let's Encrypt 证书并开启强制 HTTPS；
6. 用 **系统加固 → 服务** 或 `systemctl` 注册 `deploy/codex-web.service` 启动后端。

## 9. 升级、备份与卸载

### 升级

```bash
cd codex-web
git pull
sudo systemctl restart codex-web        # Docker：docker compose up -d --build
```

`config.json` 会在启动时自动补齐新增字段；旧版单账号配置会自动迁移成多账号。

### 备份（一定要一起备份）

```bash
tar czf codex-web-backup-$(date +%F).tgz config.json data/
```

`data/secrets.key` 丢失后，已保存的 API Key 无法解密，需要在网页里重新填写。

### 卸载

```bash
sudo systemctl disable --now codex-web
sudo rm /etc/systemd/system/codex-web.service
sudo rm -rf /opt/codex-web            # 数据在这里，确认备份后再删
```

## 10. 故障排查

| 现象 | 排查方向 |
| --- | --- |
| 网页一直转圈、看不到输出 | nginx 没关 `proxy_buffering`；或 `proxy_read_timeout` 太短 |
| 登录成功但立刻掉线 | 反向代理没有透传 `X-Forwarded-Proto`，或 `sessionSecret` 每次启动都在变（说明配置没写成功） |
| 任务报 401 | API Key 错误、Base URL 与 `wire_api` 不匹配，或供应商不支持该接口；用「测试连接」确认 |
| 任务报 `Model metadata ... not found` | 在供应商里指定 `model_catalog_json`，或忽略（使用兜底元数据） |
| 任务立刻被终止并提示策略拦截 | 命中「禁止执行的命令」或「受保护路径」，可在「本机权限」里查看与调整 |
| 目录选择器点不开 | 账号没有「浏览目录」权限，或该路径不在「目录浏览范围」内 |
| 服务启动即退出 | `journalctl -u codex-web -n 50`；常见原因是 `codexBin` 路径不对或端口被占用 |
