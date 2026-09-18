# Codex Web

[中文](README.md) | English

A self-hosted, ChatGPT-desktop-style web client for the local **Codex CLI**, built for small teams:
pick a model in the browser, run tasks, watch commands and file changes stream in — while an admin
manages model providers, API keys, accounts and the boundaries Codex may touch on the machine.

Zero runtime dependencies: Node.js ≥ 20 plus the `codex` binary.

## Highlights

- **Browser-driven Codex** — the server converts `codex exec --json` JSONL events into SSE; the UI renders
  chat bubbles, command cards (output + exit code), file changes and token usage.
- **Bring your own model** — add any OpenAI-compatible provider (DeepSeek, OpenAI, Ollama, vLLM, …) and
  switch the model per task from the toolbar.
- **API keys are never stored in plaintext** — keys are AES-256-GCM encrypted inside `config.json`
  (`enc:v1:…`), the UI/API only ever sees `sk-****d00a`, and at run time the key is injected into the
  child process **environment variable** only (never in `argv`, logs or audit records).
- **Machine-level permission control** — restrict the directories Codex may work in, deny dangerous
  commands, protect paths such as `/etc` or `~/.ssh`, cap run time, toggle workspace network access,
  limit concurrency, and keep an audit log of every task.
- **Multi-account with per-user permissions** — admin/member roles, per-account sandbox ceiling and
  working directory, session ownership so members only see their own threads, and an optional
  "must change password on first login" flag (the default `admin`/`admin` account uses it).

## Quick start

```bash
# 1. Codex CLI
npm install -g @openai/codex     # or: brew install codex

# 2. Clone and configure
git clone https://github.com/<you>/codex-web.git && cd codex-web
cp config.example.json config.json
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # paste into sessionSecret

# 3. Run
node server.js                   # http://127.0.0.1:8790
```

Sign in with the default account `admin` / `admin`; you will be required to set a new password
immediately (minimum 8 characters) before anything else becomes available.

Then open **Settings → Models & API keys** to add a provider (for example DeepSeek with
`https://api.deepseek.com`, wire API `responses`), or use the CLI:

```bash
node model-admin.js add deepseek --name DeepSeek --base-url https://api.deepseek.com \
  --wire-api responses --models deepseek-chat,deepseek-reasoner --key sk-xxxx --activate
node model-admin.js import --strip   # import existing ~/.codex/config.toml providers and drop plaintext keys
```

Production deploys (systemd, nginx + TLS, Docker, macOS launchd, Windows/WSL2) are documented in
[docs/deployment.md](docs/deployment.md); provider recipes in [docs/models.md](docs/models.md);
permission model and hardening in [docs/permissions.md](docs/permissions.md).

## Verify without spending tokens

```bash
bash scripts/smoke-test.sh
```

The smoke test boots an isolated instance with a fake `codex` binary and checks login, key
encryption/masking, policy enforcement (out-of-scope directory, blocked command), the child-process
environment and the audit log.

## Security in one paragraph

This service runs Codex as the user who started it (usually `root`), so anyone who can log in can act
on the machine. The permission features are product-level guardrails, not an OS sandbox: expose the
service only behind nginx/HTTPS, give members the least privilege, prefer `read-only`/`workspace-write`,
and use containers or VMs when you need real isolation. See [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
