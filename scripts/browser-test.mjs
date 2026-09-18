// 浏览器端端到端测试（可选）：用真实 Chrome 验证界面布局与交互，
// 例如「弹窗里能不能滚到保存按钮」「输入框下方的权限快捷选择是否生效」。
//
//   npm i -D puppeteer        # 会下载 Chrome（约 180MB）；已安装的系统 Chrome 可用
//   PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome npm run test:browser
//
// 没安装 puppeteer 时会自动跳过，不影响 CI 的基础测试。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

let puppeteer;
try {
  puppeteer = (await import("puppeteer")).default;
} catch {
  console.log("跳过浏览器测试：未安装 puppeteer（npm i -D puppeteer 后再试）");
  process.exit(0);
}

const PORT = Number(process.env.BROWSER_TEST_PORT || 8877);
const work = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-browser-"));
const ws = path.join(work, "ws");
fs.mkdirSync(path.join(work, "data"), { recursive: true });
fs.mkdirSync(ws, { recursive: true });

let pass = 0;
let fail = 0;
const check = (message, condition, extra = "") => {
  if (condition) {
    pass += 1;
    console.log(`  \u001b[32m✓\u001b[0m ${message}${extra ? `（${extra}）` : ""}`);
  } else {
    fail += 1;
    console.log(`  \u001b[31m✗\u001b[0m ${message}${extra ? `（${extra}）` : ""}`);
  }
};

// 假的 codex：立刻回一句，方便测「任务完成」相关行为
fs.writeFileSync(
  path.join(work, "fake-codex"),
  `#!/usr/bin/env bash
echo '{"type":"thread.started","thread_id":"b1"}'
echo '{"type":"item.completed","item":{"id":"m1","type":"agent_message","text":"好的，已完成"}}'
`,
  { mode: 0o755 }
);

const cfg = JSON.parse(fs.readFileSync(path.join(HERE, "config.example.json"), "utf8"));
Object.assign(cfg, {
  port: PORT,
  sessionSecret: "browser-test-secret-browser-test-secret",
  codexBin: path.join(work, "fake-codex"),
  defaultCwd: ws,
  users: [],
});
fs.writeFileSync(path.join(work, "config.json"), `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });

const env = {
  ...process.env,
  CODEX_WEB_CONFIG: path.join(work, "config.json"),
  CODEX_WEB_DATA_DIR: path.join(work, "data"),
};
const cli = (args) => spawnSync("node", [path.join(HERE, args[0]), ...args.slice(1)], { env, encoding: "utf8" });
cli(["user-admin.js", "add", "admin", "admin-pass-123", "--admin"]);
cli(["user-admin.js", "add", "member", "member-pass-123", "--sandbox", "read-only", "--cwd", ws]);

const server = spawn("node", [path.join(HERE, "server.js")], { env, stdio: "ignore" });
const base = `http://127.0.0.1:${PORT}`;
for (let i = 0; i < 60; i += 1) {
  try {
    const res = await fetch(`${base}/api/session`);
    if (res.status === 401) break;
  } catch {
    /* 还没起来 */
  }
  await new Promise((resolve) => setTimeout(resolve, 200));
}

let browser;
try {
  browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });

  const login = async (page, username, password) => {
    await page.goto(base, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#loginScreen:not(.hidden)", { timeout: 15000 });
    // 登录框里预填了 admin，这里直接赋值，避免拼成 adminadmin
    await page.$eval("#loginUser", (el, value) => {
      el.value = value;
    }, username);
    await page.$eval("#loginPass", (el, value) => {
      el.value = value;
    }, password);
    await page.click("#loginForm button[type=submit]");
    await page.waitForSelector("#app:not(.hidden)", { timeout: 15000 });
  };

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  const runBodies = [];
  page.on("request", (req) => {
    if (req.url().endsWith("/api/run")) {
      try {
        runBodies.push(JSON.parse(req.postData()));
      } catch {
        /* 忽略解析失败 */
      }
    }
  });
  await login(page, "admin", "admin-pass-123");

  console.log("== 新增账号弹窗：内容可滚动、保存按钮可见");
  await page.click("#settingsBtn");
  await page.click("#settingsUsersBtn");
  await page.waitForSelector("#usersModal:not(.hidden)");
  await page.click("#userNewBtn");
  await page.waitForSelector("#userForm:not(.hidden)");
  const layout = await page.evaluate(() => {
    const body = document.querySelector("#usersModal .modal-body");
    const card = document.querySelector("#usersModal .modal-card");
    const save = document.querySelector("#userForm button[type=submit]");
    const scrollable = body.scrollHeight - body.clientHeight;
    body.scrollTop = body.scrollHeight;
    const rect = save.getBoundingClientRect();
    const cardRect = card.getBoundingClientRect();
    return {
      scrollable,
      saveVisible: rect.bottom <= cardRect.bottom + 1 && rect.top >= cardRect.top - 1,
      viewport: rect.bottom <= window.innerHeight && rect.top >= 0,
    };
  });
  check("弹窗内容区出现滚动条", layout.scrollable > 20, `可滚动 ${Math.round(layout.scrollable)}px`);
  check("滚到底部后「保存」按钮完整可见", layout.saveVisible && layout.viewport);

  await page.$eval("#ufUsername", (el) => {
    el.value = "tester1";
  });
  await page.$eval("#ufPassword", (el) => {
    el.value = "tester1-pass";
  });
  await page.evaluate(() => document.querySelector("#userForm button[type=submit]").click());
  await page.waitForFunction(() => document.querySelector("#usersHint").textContent.includes("2 个账号"), { timeout: 10000 });
  check("通过弹窗成功新增账号", true);
  await page.click("#usersClose");

  console.log("== 输入框下方的权限快捷选择");
  const quick = await page.$$eval("#sandboxQuick .sq-btn", (els) =>
    els.map((el) => ({ label: el.textContent, value: el.dataset.sandbox }))
  );
  check("有三个快捷选项", quick.length === 3, quick.map((item) => `${item.label}=${item.value}`).join(" / "));
  check(
    "「完全控制」对应 danger-full-access",
    quick.some((item) => item.label === "完全控制" && item.value === "danger-full-access")
  );
  await page.evaluate(() =>
    [...document.querySelectorAll("#sandboxQuick .sq-btn")].find((el) => el.dataset.sandbox === "danger-full-access").click()
  );
  const afterClick = await page.evaluate(() => ({
    select: document.querySelector("#sandboxSelect").value,
    note: document.querySelector(".composer-note").textContent,
    active: document.querySelector("#sandboxQuick .sq-btn.active")?.textContent,
  }));
  check("顶部下拉同步为完全访问", afterClick.select === "danger-full-access", afterClick.select);
  check("快捷按钮高亮为「完全控制」", afterClick.active === "完全控制");
  check("底部提示显示当前模式", afterClick.note.includes("当前模式：完全访问"));

  await page.type("#promptInput", "测试一下");
  await page.click("#sendBtn");
  await page.waitForFunction(() => document.querySelector("#statusText").textContent === "就绪", { timeout: 15000 });
  check("提交任务的 payload 里 sandbox=danger-full-access", runBodies.at(-1)?.sandbox === "danger-full-access");
  await new Promise((resolve) => setTimeout(resolve, 1300));
  check("任务完成后标签图标变成完成色", (await page.evaluate(() => document.documentElement.dataset.tabState)) === "done");
  check("任务完成后标题带完成标记", (await page.title()).startsWith("✅"));

  console.log("== 只读成员：超上限的档位不可选");
  const memberContext = await browser.createBrowserContext();
  const memberPage = await memberContext.newPage();
  await memberPage.setViewport({ width: 1280, height: 720 });
  await login(memberPage, "member", "member-pass-123");
  const memberQuick = await memberPage.$$eval("#sandboxQuick .sq-btn", (els) =>
    els.map((el) => ({ value: el.dataset.sandbox, disabled: el.disabled, active: el.classList.contains("active") }))
  );
  check("无法选择「完全控制」", memberQuick.find((item) => item.value === "danger-full-access")?.disabled === true);
  check("无法选择「工作区可写」", memberQuick.find((item) => item.value === "workspace-write")?.disabled === true);
  check("当前处于只读模式", memberQuick.find((item) => item.value === "read-only")?.active === true);
} catch (err) {
  fail += 1;
  console.log(`  \u001b[31m✗\u001b[0m 浏览器测试异常：${err.message}`);
} finally {
  if (browser) await browser.close();
  server.kill();
  fs.rmSync(work, { recursive: true, force: true });
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
