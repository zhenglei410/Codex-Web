// 前端行为测试（可选，需要 jsdom：npm install 之后运行 `npm run test:ui`）
//
// 验证两件事：
//   1. 回答过程中对话区自动滑到底部（用户主动上翻时才暂停跟随）；
//   2. 回答结束后浏览器标签闪烁一次并保留提示色，用户回到页面后自动恢复。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PUBLIC_DIR = path.join(HERE, "public");

let JSDOM;
try {
  ({ JSDOM } = await import("jsdom"));
} catch {
  console.log("跳过前端测试：未安装 jsdom（执行 npm install 后再试）");
  process.exit(0);
}

const html = fs
  .readFileSync(path.join(PUBLIC_DIR, "index.html"), "utf8")
  .replace(/<script[^>]*app\.js[^>]*><\/script>/, "");
const appJs = fs.readFileSync(path.join(PUBLIC_DIR, "app.js"), "utf8");

let pass = 0;
let fail = 0;
const ok = (message) => {
  pass += 1;
  console.log(`  \u001b[32m✓\u001b[0m ${message}`);
};
const bad = (message) => {
  fail += 1;
  console.log(`  \u001b[31m✗\u001b[0m ${message}`);
};
const check = (message, condition) => (condition ? ok(message) : bad(message));

const dom = new JSDOM(html, { url: "http://127.0.0.1:8790/", runScripts: "outside-only", pretendToBeVisual: true });
const { window } = dom;
window.TextDecoder = TextDecoder;
window.Response = Response;
window.Request = Request;
window.Headers = Headers;

// ---- 模拟后端：session / threads / 一次 Run 的 SSE 事件流 ----
const encoder = new TextEncoder();
const events = [
  { type: "run.started", runId: "r1", cwd: "/tmp", model: "deepseek-flash", sandbox: "read-only" },
  { type: "thread.started", thread_id: "t1" },
  { type: "item.completed", item: { id: "i1", type: "agent_message", text: "第一段回答" } },
  {
    type: "item.completed",
    item: { id: "i2", type: "command_execution", command: "ls", aggregated_output: "a\nb", status: "completed", exit_code: 0 },
  },
  { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 5 } },
  { type: "run.exited", runId: "r1", code: 0, durationMs: 100 },
];

const json = (body, status = 200) =>
  new window.Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

window.fetch = async (url) => {
  if (String(url) === "/api/session") {
    return json({
      username: "admin",
      role: "admin",
      permissions: {
        run: true,
        browse: true,
        threads: true,
        threadsAll: true,
        manageUsers: true,
        sandboxMax: "danger-full-access",
        defaultCwd: "/root",
      },
      defaultCwd: "/root",
      sandbox: "read-only",
      model: "",
      models: [{ id: "deepseek-flash", label: "deepseek-flash · deepseek", provider: "deepseek" }],
      activeProvider: "deepseek",
      policy: { enabled: true, allowedRoots: [], browseRoots: [], allowNetwork: true, maxRunMinutes: 0 },
      mustChangePassword: false,
    });
  }
  if (String(url) === "/api/threads") {
    return json({
      threads: [{ id: "t-history", title: "历史会话", model: "deepseek-flash", cwd: "/root", updatedAt: new Date().toISOString() }],
      scoped: false,
    });
  }
  if (String(url) === "/api/threads/t-history") {
    return json({
      meta: { id: "t-history", cwd: "/root", model: "deepseek-flash" },
      messages: [
        { role: "user", text: "帮我看看目录" },
        { role: "assistant", text: "第一段回答" },
        { role: "tool", name: "exec_command", args: '{"cmd":"ls"}', output: "a\nb" },
        { role: "assistant", text: "第二段回答" },
      ],
    });
  }
  if (String(url) === "/api/run") {
    let index = 0;
    const stream = {
      getReader: () => ({
        read: async () => {
          if (index >= events.length) return { done: true, value: undefined };
          return { done: false, value: encoder.encode(`data: ${JSON.stringify(events[index++])}\n\n`) };
        },
      }),
    };
    return new window.Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
  }
  return json({});
};

// jsdom 不做布局，这里伪造消息区的高度，模拟「内容已经超出视口」
const messages = window.document.getElementById("messages");
let scrollHeight = 1000;
Object.defineProperty(messages, "scrollHeight", { get: () => scrollHeight, configurable: true });
Object.defineProperty(messages, "clientHeight", { get: () => 400, configurable: true });
messages.scrollTo = ({ top } = {}) => {
  messages.scrollTop = top ?? 0;
};

window.eval(appJs);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const iconColor = () =>
  decodeURIComponent(window.document.querySelector('link[rel="icon"]').href)
    .match(/fill="(#[0-9a-f]{6})"/i)?.[1]
    ?.toLowerCase();

await sleep(60);
check("登录后进入主界面", !window.document.getElementById("app").classList.contains("hidden"));

console.log("== 回答过程中自动滑到底部");
window.document.getElementById("promptInput").value = "生成一段很长的回答";
scrollHeight = 3000;
window.document.getElementById("composer").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
await sleep(120);
check("内容超出视口后仍然贴在最底部", messages.scrollTop === messages.scrollHeight);

messages.scrollTop = 100;
messages.dispatchEvent(new window.Event("scroll"));
scrollHeight = 4000;
await sleep(80);
check("用户主动上翻后不再强制拉回底部", messages.scrollTop === 100);

window.document.getElementById("scrollBottomBtn").dispatchEvent(new window.Event("click", { bubbles: true }));
await sleep(60);
check("点「跳到最底部」后恢复跟随", messages.scrollTop === messages.scrollHeight);

console.log("== 回答结束后的标签提示");
await sleep(700);
check("标题带上完成标记", window.document.title.startsWith("✅"));
check("favicon 保持提示色 #f0a020", iconColor() === "#f0a020");

window.document.dispatchEvent(new window.Event("pointerdown", { bubbles: true }));
await sleep(20);
check("用户回到页面后 favicon 恢复 #10a37f", iconColor() === "#10a37f");
check("用户回到页面后标题恢复", window.document.title === "Codex Web");

console.log("== 打开历史会话");
await sleep(50);
const threadButton = window.document.querySelector("#threadList button");
check("侧边栏里有历史会话", Boolean(threadButton));
threadButton?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await sleep(80);
check("历史会话里没有一直转圈的动画", window.document.querySelectorAll(".turn.assistant .spin-wrap .spinner").length === 0);
check("历史会话里没有 thinking 占位", window.document.querySelectorAll(".turn.assistant .thinking").length === 0);
check("连续的 assistant/tool 消息合并成一个 Codex 回合", window.document.querySelectorAll(".turn.assistant").length === 1);
const historyText = window.document.getElementById("messages").textContent;
check("历史内容都渲染出来了", historyText.includes("第一段回答") && historyText.includes("第二段回答") && historyText.includes("ls"));

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
