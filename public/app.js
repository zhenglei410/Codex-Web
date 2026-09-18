// Codex Web front-end — renders the SSE event stream from `codex exec --json`.
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  username: "",
  role: "member",
  permissions: {},
  cwd: "/root",
  model: "",
  sandbox: "danger-full-access",
  threadId: null,
  running: false,
  runId: null,
  turn: null,
  threads: [],
  search: "",
  hasNewBelow: false,
  policy: {},
  mustChangePassword: false,
  // 回答过程中是否自动跟随滚动到底部（用户手动往上翻会暂停跟随）
  followBottom: true,
  runNotified: false,
};

const els = {
  loginScreen: $("#loginScreen"),
  loginForm: $("#loginForm"),
  loginUser: $("#loginUser"),
  loginPass: $("#loginPass"),
  loginError: $("#loginError"),
  app: $("#app"),
  sidebar: $("#sidebar"),
  sidebarToggle: $("#sidebarToggle"),
  newChatBtn: $("#newChatBtn"),
  searchInput: $("#searchInput"),
  threadList: $("#threadList"),
  cwdBtn: $("#cwdBtn"),
  cwdLabel: $("#cwdLabel"),
  settingsBtn: $("#settingsBtn"),
  settingsModal: $("#settingsModal"),
  settingsClose: $("#settingsClose"),
  settingsUsersBtn: $("#settingsUsersBtn"),
  settingsModelsBtn: $("#settingsModelsBtn"),
  settingsPolicyBtn: $("#settingsPolicyBtn"),
  settingsPwdBtn: $("#settingsPwdBtn"),
  settingsLogoutBtn: $("#settingsLogoutBtn"),
  themeSegmented: $("#themeSegmented"),
  stUserName: $("#stUserName"),
  stUserAvatar: $("#stUserAvatar"),
  stUserRoleChip: $("#stUserRoleChip"),
  userName: $("#userName"),
  userAvatar: $("#userAvatar"),
  topbarTitle: $("#topbarTitle"),
  modelSelect: $("#modelSelect"),
  sandboxSelect: $("#sandboxSelect"),
  messages: $("#messages"),
  emptyState: $("#emptyState"),
  emptyCwd: $("#emptyCwd"),
  scrollNav: $("#scrollNav"),
  scrollTopBtn: $("#scrollTopBtn"),
  scrollBottomBtn: $("#scrollBottomBtn"),
  composer: $("#composer"),
  promptInput: $("#promptInput"),
  sendBtn: $("#sendBtn"),
  stopBtn: $("#stopBtn"),
  statusText: $("#statusText"),
  toast: $("#toast"),
  pwdModal: $("#pwdModal"),
  pwdForm: $("#pwdForm"),
  pwdClose: $("#pwdClose"),
  pwdCurrent: $("#pwdCurrent"),
  pwdNew: $("#pwdNew"),
  pwdConfirm: $("#pwdConfirm"),
  pwdError: $("#pwdError"),
  pwdNotice: $("#pwdNotice"),
  userRoleChip: $("#userRoleChip"),
  usersModal: $("#usersModal"),
  usersClose: $("#usersClose"),
  usersList: $("#usersList"),
  usersHint: $("#usersHint"),
  userNewBtn: $("#userNewBtn"),
  userForm: $("#userForm"),
  userFormTitle: $("#userFormTitle"),
  userFormClose: $("#userFormClose"),
  userFormError: $("#userFormError"),
  userFormNote: $("#userFormNote"),
  ufUsername: $("#ufUsername"),
  ufDisplay: $("#ufDisplay"),
  ufPassword: $("#ufPassword"),
  ufPasswordLabel: $("#ufPasswordLabel"),
  ufRole: $("#ufRole"),
  ufSandbox: $("#ufSandbox"),
  ufCwd: $("#ufCwd"),
  ufRun: $("#ufRun"),
  ufBrowse: $("#ufBrowse"),
  ufThreads: $("#ufThreads"),
  ufThreadsAll: $("#ufThreadsAll"),
  ufManage: $("#ufManage"),
  ufMustChange: $("#ufMustChange"),
  ufDisabled: $("#ufDisabled"),
  threadListWrap: $("#threadListWrap"),
  cwdModal: $("#cwdModal"),
  cwdClose: $("#cwdClose"),
  cwdPath: $("#cwdPath"),
  cwdList: $("#cwdList"),
  cwdUp: $("#cwdUp"),
  cwdGo: $("#cwdGo"),
  cwdPick: $("#cwdPick"),
  cwdHint: $("#cwdHint"),
  modelsModal: $("#modelsModal"),
  modelsClose: $("#modelsClose"),
  modelsList: $("#modelsList"),
  modelsHint: $("#modelsHint"),
  modelNewBtn: $("#modelNewBtn"),
  modelForm: $("#modelForm"),
  modelFormTitle: $("#modelFormTitle"),
  modelFormClose: $("#modelFormClose"),
  modelFormError: $("#modelFormError"),
  modelFormNote: $("#modelFormNote"),
  mfId: $("#mfId"),
  mfName: $("#mfName"),
  mfBaseUrl: $("#mfBaseUrl"),
  mfWireApi: $("#mfWireApi"),
  mfEnvKey: $("#mfEnvKey"),
  mfApiKey: $("#mfApiKey"),
  mfApiKeyLabel: $("#mfApiKeyLabel"),
  mfModels: $("#mfModels"),
  mfDefault: $("#mfDefault"),
  mfCatalog: $("#mfCatalog"),
  mfReasoning: $("#mfReasoning"),
  mfActive: $("#mfActive"),
  mfNoSave: $("#mfNoSave"),
  policyModal: $("#policyModal"),
  policyClose: $("#policyClose"),
  policyForm: $("#policyForm"),
  policyError: $("#policyError"),
  policyHint: $("#policyHint"),
  pfEnabled: $("#pfEnabled"),
  pfNetwork: $("#pfNetwork"),
  pfAudit: $("#pfAudit"),
  pfRoots: $("#pfRoots"),
  pfBrowse: $("#pfBrowse"),
  pfDeny: $("#pfDeny"),
  pfProtect: $("#pfProtect"),
  pfMaxMinutes: $("#pfMaxMinutes"),
  pfGlobalRuns: $("#pfGlobalRuns"),
  pfUserRuns: $("#pfUserRuns"),
  auditList: $("#auditList"),
  composerNote: $(".composer-note"),
};

// ------------------------------------------------------------------ utils

// ------------------------------------------------------------------ 标签页提示
//
// 回答结束时让浏览器标签「闪一下」并保留提示色（favicon 换色 + 标题前缀），
// 用户回到这个标签页（聚焦 / 切回可见 / 点击按键）后自动恢复。
const FAVICON_IDLE = "#10a37f";
const FAVICON_DONE = "#f0a020";
const PAGE_TITLE = document.title || "Codex Web";
const faviconLink = document.querySelector('link[rel="icon"]');
let tabFlashTimers = [];
let tabAlerting = false;

function faviconDataUri(color) {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">` +
    `<rect width="32" height="32" rx="8" fill="${color}"/>` +
    `<path d="M9 20.5l7-11.5 7 11.5z" fill="white"/></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function setFaviconColor(color) {
  if (faviconLink) faviconLink.href = faviconDataUri(color);
}

// 闪烁一次（亮-暗-亮-暗-亮），最后停在提示色上并保持不变
function flashTabOnce() {
  clearTabFlash();
  tabAlerting = true;
  const sequence = [FAVICON_DONE, FAVICON_IDLE, FAVICON_DONE, FAVICON_IDLE, FAVICON_DONE];
  sequence.forEach((color, index) => {
    tabFlashTimers.push(
      setTimeout(() => {
        setFaviconColor(color);
        if (index === sequence.length - 1) {
          setFaviconColor(FAVICON_DONE);
          document.title = `✅ ${PAGE_TITLE}`;
        }
      }, index * 220)
    );
  });
}

function clearTabFlash() {
  for (const timer of tabFlashTimers) clearTimeout(timer);
  tabFlashTimers = [];
}

function resetTabAlert() {
  if (!tabAlerting && document.title === PAGE_TITLE) return;
  clearTabFlash();
  tabAlerting = false;
  setFaviconColor(FAVICON_IDLE);
  document.title = PAGE_TITLE;
}

window.addEventListener("focus", resetTabAlert);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") resetTabAlert();
});
document.addEventListener("pointerdown", resetTabAlert, { passive: true });
document.addEventListener("keydown", resetTabAlert);

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

function renderMarkdown(source) {
  const codes = [];
  const text = String(source ?? "").replace(/```([\w+-]*)\r?\n?([\s\S]*?)```/g, (_m, _lang, code) => {
    codes.push(code.replace(/\n$/, ""));
    return `\u0000${codes.length - 1}\u0000`;
  });

  const inline = (s) =>
    s
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*\w])\*([^*\n]+)\*/g, "$1<em>$2</em>")
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>')
      .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noreferrer">$2</a>');

  const out = [];
  let listType = null;
  const closeList = () => {
    if (listType) {
      out.push(listType === "ul" ? "</ul>" : "</ol>");
      listType = null;
    }
  };

  for (const rawLine of escapeHtml(text).split("\n")) {
    const line = rawLine.replace(
      /\u0000(\d+)\u0000/g,
      (_m, i) => `<pre><code>${escapeHtml(codes[Number(i)])}</code></pre>`
    );
    if (!line.trim()) {
      closeList();
      continue;
    }
    if (line.startsWith("<pre>")) {
      closeList();
      out.push(line);
      continue;
    }
    const heading = line.match(/^#{1,6}\s+(.*)$/);
    if (heading) {
      closeList();
      out.push(`<h3>${inline(heading[1])}</h3>`);
      continue;
    }
    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    if (bullet) {
      if (listType !== "ul") {
        closeList();
        out.push("<ul>");
        listType = "ul";
      }
      out.push(`<li>${inline(bullet[1])}</li>`);
      continue;
    }
    const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (numbered) {
      if (listType !== "ol") {
        closeList();
        out.push("<ol>");
        listType = "ol";
      }
      out.push(`<li>${inline(numbered[1])}</li>`);
      continue;
    }
    const quote = line.match(/^&gt;\s?(.*)$/);
    if (quote) {
      closeList();
      out.push(`<blockquote>${inline(quote[1])}</blockquote>`);
      continue;
    }
    closeList();
    out.push(`<p>${inline(line)}</p>`);
  }
  closeList();
  return out.join("");
}

function relativeTime(iso) {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const diff = Date.now() - then;
  const mins = Math.round(diff / 60000);
  if (mins < 1) return "刚刚";
  if (mins < 60) return `${mins} 分钟前`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} 天前`;
  return new Date(then).toLocaleDateString("zh-CN");
}

function formatBytes(bytes) {
  if (bytes == null) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value >= 10 || i === 0 ? Math.round(value) : value.toFixed(1)}${units[i]}`;
}

let toastTimer = null;
function toast(message) {
  els.toast.textContent = message;
  els.toast.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.add("hidden"), 3600);
}

// ------------------------------------------------------------------ theme

function applyTheme(theme) {
  const next = theme === "light" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  localStorage.setItem("codex-theme", next);
  $$(".seg-btn", els.themeSegmented).forEach((button) => {
    button.classList.toggle("active", button.dataset.themeValue === next);
  });
}

els.themeSegmented.addEventListener("click", (event) => {
  const button = event.target.closest(".seg-btn");
  if (button) applyTheme(button.dataset.themeValue);
});

applyTheme(localStorage.getItem("codex-theme") || "dark");

// ------------------------------------------------------------------ settings

function openSettingsModal() {
  els.settingsModal.classList.remove("hidden");
}

function closeSettingsModal() {
  els.settingsModal.classList.add("hidden");
}

els.settingsBtn.addEventListener("click", openSettingsModal);
els.settingsClose.addEventListener("click", closeSettingsModal);
els.settingsModal.addEventListener("click", (event) => {
  if (event.target === els.settingsModal) closeSettingsModal();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !els.settingsModal.classList.contains("hidden")) closeSettingsModal();
});

els.settingsUsersBtn.addEventListener("click", () => {
  closeSettingsModal();
  openUsersModal();
});
els.settingsModelsBtn.addEventListener("click", () => {
  closeSettingsModal();
  openModelsModal();
});
els.settingsPolicyBtn.addEventListener("click", () => {
  closeSettingsModal();
  openPolicyModal();
});
els.settingsPwdBtn.addEventListener("click", () => {
  closeSettingsModal();
  openPasswordModal();
});

// ------------------------------------------------------------------ auth

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  // 强制改密：任何被拦下的接口都统一把用户拉回改密弹窗
  if (res.status === 403) {
    const data = await res.clone().json().catch(() => null);
    if (data?.code === "password_change_required") {
      state.mustChangePassword = true;
      openPasswordModal(true);
      toast(data.error || "请先修改密码");
    }
  }
  return res;
}

async function boot() {
  const res = await api("/api/session");
  if (!res.ok) {
    els.loginScreen.classList.remove("hidden");
    els.app.classList.add("hidden");
    return;
  }
  const session = await res.json();
  enterApp(session);
}

function enterApp(session) {
  state.username = session.username;
  state.role = session.role || "member";
  state.permissions = session.permissions || {};
  state.cwd = session.defaultCwd || localStorage.getItem("codex-cwd") || "/root";
  state.sandbox = session.sandbox || "danger-full-access";
  state.model = session.model || "";
  state.policy = session.policy || {};
  state.mustChangePassword = Boolean(session.mustChangePassword);

  els.loginScreen.classList.add("hidden");
  els.app.classList.remove("hidden");
  els.userName.textContent = session.username;
  els.userAvatar.textContent = session.username.slice(0, 1).toUpperCase();
  els.stUserName.textContent = session.username;
  els.stUserAvatar.textContent = session.username.slice(0, 1).toUpperCase();
  els.cwdLabel.textContent = state.cwd;
  els.emptyCwd.textContent = state.cwd;
  els.sandboxSelect.value = state.sandbox;
  populateModelSelect(session);
  els.promptInput.focus();

  applyPermissions(session);
  loadThreads();
  updateScrollNav();

  // 首次登录/被重置密码：先改密码，其他功能等改完再用
  if (state.mustChangePassword) {
    els.promptInput.blur();
    openPasswordModal(true);
  }
}

// 模型下拉框由服务端配置生成：只列出已配置供应商的模型
function populateModelSelect(session) {
  const models = Array.isArray(session.models) ? session.models : [];
  els.modelSelect.innerHTML = "";
  const fallback = document.createElement("option");
  fallback.value = "";
  fallback.textContent = session.activeProvider ? `默认模型（${session.activeProvider}）` : "默认模型";
  els.modelSelect.appendChild(fallback);
  for (const model of models) {
    const option = document.createElement("option");
    option.value = model.id;
    option.textContent = model.label || model.id;
    els.modelSelect.appendChild(option);
  }
  els.modelSelect.value = models.some((model) => model.id === state.model) ? state.model : "";
  els.modelSelect.disabled = !models.length;
  els.modelSelect.title = models.length
    ? "选择本次任务使用的大模型"
    : "未配置模型供应商：请在「设置 → 模型与 API Key」里添加，或留空使用 Codex 自身配置的默认模型";
}

// 按账号权限调整界面：能做什么、能选到哪一档
const SANDBOX_ORDER = { "read-only": 0, "workspace-write": 1, "danger-full-access": 2 };
const SANDBOX_LABEL = { "read-only": "只读", "workspace-write": "工作区可写", "danger-full-access": "完全访问" };

function canRunTasks() {
  return state.permissions.run !== false;
}

function applyPermissions(session) {
  const perms = state.permissions;
  const isAdmin = state.role === "admin";

  els.userRoleChip.classList.toggle("hidden", !isAdmin);
  els.userRoleChip.textContent = isAdmin ? "管理员" : "";
  els.stUserRoleChip.classList.toggle("hidden", !isAdmin);
  els.stUserRoleChip.textContent = isAdmin ? "管理员" : "";
  els.settingsUsersBtn.classList.toggle("hidden", !perms.manageUsers);
  els.settingsModelsBtn.classList.toggle("hidden", !perms.manageUsers);
  els.settingsPolicyBtn.classList.toggle("hidden", !perms.manageUsers);

  // 历史会话
  els.threadListWrap.classList.toggle("hidden", !perms.threads);
  if (!perms.threads) els.threadList.innerHTML = "";

  // 目录浏览
  els.cwdBtn.classList.toggle("hidden", !perms.browse);
  if (!perms.browse) {
    state.cwd = session.defaultCwd || "/root";
    localStorage.removeItem("codex-cwd");
    els.cwdLabel.textContent = state.cwd;
    els.emptyCwd.textContent = state.cwd;
  }

  // 权限模式只保留账号允许的档位
  const maxRank = SANDBOX_ORDER[perms.sandboxMax] ?? SANDBOX_ORDER["danger-full-access"];
  for (const option of [...els.sandboxSelect.options]) {
    option.disabled = SANDBOX_ORDER[option.value] > maxRank;
  }
  if ((SANDBOX_ORDER[state.sandbox] ?? 9) > maxRank) {
    state.sandbox = perms.sandboxMax;
    els.sandboxSelect.value = state.sandbox;
  }
  els.sandboxSelect.disabled = maxRank === 0;

  // 任务提交（强制改密期间一并锁住）
  const locked = state.mustChangePassword;
  els.sendBtn.disabled = locked || !canRunTasks();
  els.promptInput.disabled = locked || !canRunTasks();
  els.promptInput.placeholder = locked
    ? "请先修改密码"
    : canRunTasks()
      ? "给 Codex 下达任务…（Enter 发送，Shift+Enter 换行）"
      : "当前账号没有执行 Codex 的权限";

  // 底部提示：把当前生效的权限边界直接写出来
  const policy = state.policy || {};
  const notes = [`权限上限：${SANDBOX_LABEL[perms.sandboxMax] || perms.sandboxMax}`];
  if (policy.enabled === false) notes.push("本机策略：已停用");
  else {
    notes.push(`工作目录：${(policy.allowedRoots || []).join("、") || "不限制"}`);
    if (policy.allowNetwork === false) notes.push("禁止联网");
    if (policy.maxRunMinutes) notes.push(`单任务 ≤ ${policy.maxRunMinutes} 分钟`);
  }
  if (els.composerNote) els.composerNote.textContent = notes.join(" · ");
}

els.loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  els.loginError.classList.add("hidden");
  const button = els.loginForm.querySelector("button[type=submit]");
  button.disabled = true;
  try {
    const res = await api("/api/login", {
      method: "POST",
      body: JSON.stringify({ username: els.loginUser.value.trim(), password: els.loginPass.value }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      els.loginError.textContent = data.error || "登录失败";
      els.loginError.classList.remove("hidden");
      return;
    }
    els.loginPass.value = "";
    await boot();
  } catch (err) {
    els.loginError.textContent = `网络错误：${err.message}`;
    els.loginError.classList.remove("hidden");
  } finally {
    button.disabled = false;
  }
});

els.settingsLogoutBtn.addEventListener("click", async () => {
  await api("/api/logout", { method: "POST" });
  location.reload();
});

// ------------------------------------------------------------------ threads

async function loadThreads() {
  try {
    const res = await api("/api/threads");
    if (!res.ok) return;
    const data = await res.json();
    state.threads = data.threads || [];
    renderThreads();
  } catch {
    /* ignore */
  }
}

function renderThreads() {
  const keyword = state.search.trim().toLowerCase();
  const list = state.threads.filter(
    (t) => !keyword || t.title.toLowerCase().includes(keyword) || (t.cwd || "").toLowerCase().includes(keyword)
  );
  els.threadList.innerHTML = "";
  for (const thread of list) {
    const button = document.createElement("button");
    button.className = `thread-item${thread.id === state.threadId ? " active" : ""}`;
    button.innerHTML = `<span class="t-title">${escapeHtml(thread.title)}</span>
      <span class="t-meta">${escapeHtml(thread.cwd || "")} · ${relativeTime(thread.updatedAt)}</span>`;
    button.addEventListener("click", () => openThread(thread.id));
    els.threadList.appendChild(button);
  }
  if (!list.length) {
    els.threadList.innerHTML = `<div class="muted" style="padding:8px 10px">暂无历史会话</div>`;
  }
}

els.searchInput.addEventListener("input", (event) => {
  state.search = event.target.value;
  renderThreads();
});

function hideEmptyState() {
  els.emptyState?.classList.add("hidden");
}

function resetMessages() {
  els.messages.innerHTML = "";
  els.messages.appendChild(els.emptyState);
  els.emptyState.classList.remove("hidden");
  state.hasNewBelow = false;
  updateScrollNav();
}

els.newChatBtn.addEventListener("click", () => {
  if (state.running) return toast("当前任务还在运行，请先停止");
  state.threadId = null;
  state.turn = null;
  els.topbarTitle.textContent = "新对话";
  els.emptyCwd.textContent = state.cwd;
  resetMessages();
  renderThreads();
  els.promptInput.focus();
});

async function openThread(id) {
  if (state.running) return toast("当前任务还在运行，请先停止");
  const res = await api(`/api/threads/${encodeURIComponent(id)}`);
  if (!res.ok) return toast("会话读取失败");
  const data = await res.json();
  state.threadId = id;
  state.turn = null;
  resetMessages();
  hideEmptyState();
  els.topbarTitle.textContent = data.meta?.model || "历史会话";
  if (data.meta?.cwd) {
    state.cwd = data.meta.cwd;
    els.cwdLabel.textContent = state.cwd;
  }
  for (const message of data.messages || []) {
    if (message.role === "user") {
      appendUserTurn(message.text);
    } else if (message.role === "assistant") {
      const turn = createAssistantTurn();
      turn.addMessage(message.text);
    } else if (message.role === "tool") {
      const turn = createAssistantTurn();
      turn.addToolHistory(message);
    }
  }
  renderThreads();
  scrollToBottom(true);
}

// ------------------------------------------------------------------ rendering

// 结果区右上/右下角的「回到最顶端 / 跳到最底部」按钮
const NEAR_BOTTOM_GAP = 120;
let scrollNavPending = false;

function isNearBottom(el = els.messages) {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_GAP;
}

function updateScrollNav() {
  const el = els.messages;
  if (!el || !els.scrollNav) return;
  const canScroll = el.scrollHeight - el.clientHeight > 24;
  const atTop = el.scrollTop <= 8;
  if (isNearBottom(el)) state.hasNewBelow = false;
  els.scrollNav.classList.toggle("hidden", !canScroll);
  els.scrollTopBtn.disabled = atTop;
  els.scrollBottomBtn.disabled = isNearBottom(el) && !state.hasNewBelow;
  els.scrollBottomBtn.classList.toggle("has-new", state.hasNewBelow);
}

function scheduleScrollNav() {
  if (scrollNavPending) return;
  scrollNavPending = true;
  requestAnimationFrame(() => {
    scrollNavPending = false;
    updateScrollNav();
  });
}

els.messages.addEventListener(
  "scroll",
  () => {
    // 只有用户自己滚动才会离开底部；程序滚动总是落在底部，因此不会误判
    if (state.running) state.followBottom = isNearBottom(els.messages);
    scheduleScrollNav();
  },
  { passive: true }
);
window.addEventListener("resize", scheduleScrollNav);

els.scrollTopBtn.addEventListener("click", () => {
  els.messages.scrollTo({ top: 0, behavior: "smooth" });
});

els.scrollBottomBtn.addEventListener("click", () => {
  state.hasNewBelow = false;
  state.followBottom = true;
  updateScrollNav();
  els.messages.scrollTo({ top: els.messages.scrollHeight, behavior: "smooth" });
});

function scrollToBottom(force = false) {
  const el = els.messages;
  const nearBottom = isNearBottom(el);
  // 任务运行中默认一直跟随底部（除非用户主动往上翻看之前的输出）
  const following = state.running && state.followBottom;
  if (force || following || nearBottom) {
    el.scrollTop = el.scrollHeight;
    state.hasNewBelow = false;
  } else {
    // 用户往上翻了：不打断阅读，只在「跳到最底部」按钮上提示有新输出
    state.hasNewBelow = true;
  }
  updateScrollNav();
}

function appendUserTurn(text) {
  const el = document.createElement("div");
  el.className = "turn user";
  const bubble = document.createElement("div");
  bubble.className = "bubble-user";
  bubble.textContent = text;
  el.appendChild(bubble);
  els.messages.appendChild(el);
  scrollToBottom(true);
}

function createAssistantTurn() {
  const el = document.createElement("div");
  el.className = "turn assistant";
  el.innerHTML = `<div class="assistant-head"><span class="badge">C</span><span>Codex</span>
    <span class="spin-wrap"></span></div><div class="assistant-body"></div>`;
  const body = el.querySelector(".assistant-body");
  els.messages.appendChild(el);
  scrollToBottom();

  const items = new Map();
  const turn = {
    el,
    body,
    items,
    thinking: null,
    showThinking(label = "正在处理…") {
      if (!this.thinking) {
        this.thinking = document.createElement("div");
        this.thinking.className = "thinking";
        this.thinking.innerHTML = `<span class="spinner"></span><span class="text"></span>`;
        body.appendChild(this.thinking);
      }
      this.thinking.querySelector(".text").textContent = label;
      scrollToBottom();
    },
    clearThinking() {
      this.thinking?.remove();
      this.thinking = null;
    },
    addNode(node, id) {
      this.clearThinking();
      body.appendChild(node);
      if (id) items.set(id, node);
      scrollToBottom();
      return node;
    },
    addMessage(text) {
      const node = document.createElement("div");
      node.className = "markdown";
      node.innerHTML = renderMarkdown(text);
      return this.addNode(node);
    },
    addLog(text) {
      const node = document.createElement("div");
      node.className = "log-line";
      node.textContent = text;
      return this.addNode(node);
    },
    addError(text) {
      const node = document.createElement("div");
      node.className = "error-card";
      node.textContent = text;
      return this.addNode(node);
    },
    addToolHistory(message) {
      const node = commandCard({
        type: "command_execution",
        command: `${message.name} ${String(message.args || "").slice(0, 400)}`,
        aggregated_output: message.output || "",
        status: "completed",
        exit_code: 0,
      });
      node.classList.add("collapsed");
      return this.addNode(node);
    },
    setUsage(usage) {
      if (!usage) return;
      const footer = document.createElement("div");
      footer.className = "turn-footer";
      const total = (usage.input_tokens || 0) + (usage.output_tokens || 0);
      footer.textContent = `↑ ${usage.input_tokens || 0} tokens（缓存 ${usage.cached_input_tokens || 0}） · ↓ ${
        usage.output_tokens || 0
      } tokens · 合计 ${total}`;
      this.el.appendChild(footer);
    },
    finish() {
      this.clearThinking();
      this.el.querySelector(".spin-wrap").innerHTML = "";
    },
  };
  el.querySelector(".spin-wrap").innerHTML = `<span class="spinner"></span>`;
  return turn;
}

function commandCard(item) {
  const node = document.createElement("div");
  node.className = "tool-card collapsed";
  node.innerHTML = `<div class="tool-head">
      <span class="tool-icon">${item.status === "in_progress" ? '<span class="spinner"></span>' : "❯"}</span>
      <code class="cmdline"></code>
      <span class="tool-status"></span>
    </div>
    <div class="tool-body"><pre class="tool-output"></pre></div>`;
  node.querySelector(".tool-head").addEventListener("click", () => node.classList.toggle("collapsed"));
  updateCommandCard(node, item);
  return node;
}

function updateCommandCard(node, item) {
  node.querySelector(".cmdline").textContent = item.command || "";
  const status = node.querySelector(".tool-status");
  const output = node.querySelector(".tool-output");
  const icon = node.querySelector(".tool-icon");
  output.textContent = item.aggregated_output || "";

  if (item.status === "in_progress") {
    status.textContent = "运行中";
    icon.innerHTML = '<span class="spinner"></span>';
    return;
  }
  icon.textContent = "❯";
  const failed = item.exit_code != null && item.exit_code !== 0;
  node.classList.toggle("failed", failed);
  status.textContent = failed ? `退出码 ${item.exit_code}` : "完成";
  if (failed || (item.aggregated_output || "").length > 0) node.classList.remove("collapsed");
}

function fileChangeCard(item) {
  const node = document.createElement("div");
  node.className = "tool-card";
  const rows = (item.changes || [])
    .map((change) => {
      const kind = change.kind || "update";
      const label = kind === "add" ? "新增" : kind === "delete" ? "删除" : "修改";
      return `<li><span class="kind ${escapeHtml(kind)}">${label}</span><code>${escapeHtml(change.path || "")}</code></li>`;
    })
    .join("");
  node.innerHTML = `<div class="tool-head">
      <span class="tool-icon">${item.status === "in_progress" ? '<span class="spinner"></span>' : "✎"}</span>
      <span class="tool-name">文件变更</span>
      <span class="tool-status">${item.status === "in_progress" ? "进行中" : "已应用"}</span>
    </div>
    <div class="tool-body"><ul class="change-list">${rows || "<li>无变更</li>"}</ul></div>`;
  node.querySelector(".tool-head").addEventListener("click", () => node.classList.toggle("collapsed"));
  return node;
}

function reasoningCard(item) {
  const node = document.createElement("details");
  node.className = "reasoning";
  const text = item.text || item.summary || "";
  node.innerHTML = `<summary>思考过程</summary><div class="reasoning-text"></div>`;
  node.querySelector(".reasoning-text").textContent = text;
  return node;
}

function genericCard(item) {
  const node = document.createElement("div");
  node.className = "tool-card collapsed";
  node.innerHTML = `<div class="tool-head"><span class="tool-icon">❯</span>
      <span class="tool-name">${escapeHtml(item.type || "事件")}</span>
      <span class="tool-status">${escapeHtml(item.status || "")}</span></div>
    <div class="tool-body"><pre class="tool-output"></pre></div>`;
  node.querySelector(".tool-output").textContent = JSON.stringify(item, null, 2).slice(0, 8000);
  node.querySelector(".tool-head").addEventListener("click", () => node.classList.toggle("collapsed"));
  return node;
}

function renderItem(turn, item, phase) {
  if (!item || !item.type) return;
  const id = item.id || `${item.type}-${Math.random().toString(36).slice(2, 8)}`;
  let node = turn.items.get(id);

  if (item.type === "agent_message") {
    if (phase === "item.completed" || item.text) {
      turn.clearThinking();
      const existing = turn.items.get(id);
      if (existing) {
        existing.innerHTML = renderMarkdown(item.text || "");
      } else {
        const element = document.createElement("div");
        element.className = "markdown";
        element.innerHTML = renderMarkdown(item.text || "");
        turn.addNode(element, id);
      }
    }
    return;
  }

  if (item.type === "reasoning") {
    if (!node) node = turn.addNode(reasoningCard(item), id);
    else node.querySelector(".reasoning-text").textContent = item.text || item.summary || "";
    return;
  }

  if (item.type === "command_execution") {
    if (!node) node = turn.addNode(commandCard(item), id);
    else updateCommandCard(node, item);
    return;
  }

  if (item.type === "file_change") {
    const replacement = fileChangeCard(item);
    if (!node) {
      turn.addNode(replacement, id);
    } else {
      node.replaceWith(replacement);
      turn.items.set(id, replacement);
    }
    return;
  }

  if (!node) turn.addNode(genericCard(item), id);
}

// ------------------------------------------------------------------ running

function setRunning(running) {
  state.running = running;
  // 新任务开始时重新打开「跟随底部」，任务结束也回到跟随状态
  if (running) {
    state.followBottom = true;
    state.runNotified = false;
  }
  els.sendBtn.disabled = running || !canRunTasks();
  els.stopBtn.classList.toggle("hidden", !running);
  els.statusText.textContent = running ? "Codex 正在执行…" : "就绪";
  els.promptInput.placeholder = !canRunTasks()
    ? "当前账号没有执行 Codex 的权限"
    : running
      ? "任务执行中，可点击右侧停止"
      : "给 Codex 下达任务…（Enter 发送，Shift+Enter 换行）";
}

function handleEvent(event) {
  const turn = state.turn;
  switch (event.type) {
    case "run.started":
      state.runId = event.runId;
      break;
    case "thread.started":
      if (event.thread_id) state.threadId = event.thread_id;
      break;
    case "turn.started":
      turn?.showThinking("Codex 正在思考…");
      break;
    case "item.started":
      turn?.showThinking("正在执行…");
      renderItem(turn, event.item, event.type);
      break;
    case "item.updated":
    case "item.completed":
      renderItem(turn, event.item, event.type);
      break;
    case "turn.completed":
      turn?.clearThinking();
      turn?.setUsage(event.usage);
      break;
    case "error":
      turn?.addError(event.message || JSON.stringify(event));
      break;
    case "policy.blocked":
      turn?.addError(event.message || "任务命中本机权限策略，已被终止");
      break;
    case "log": {
      const text = String(event.text || "").trim();
      if (text && !text.startsWith("Reading additional input")) turn?.addLog(text);
      break;
    }
    case "run.exited":
      turn?.finish();
      if (event.code && event.code !== 0) turn?.addError(`Codex 退出，退出码 ${event.code}`);
      // 回答结束：标签页闪一次并保留提示色
      if (!state.runNotified) {
        state.runNotified = true;
        flashTabOnce();
      }
      break;
    default:
      if (event.type) turn?.addLog(`[${event.type}] ${JSON.stringify(event).slice(0, 300)}`);
  }
  scrollToBottom();
}

async function sendPrompt(text) {
  if (state.running) return;
  if (!canRunTasks()) return toast("当前账号没有执行 Codex 的权限");
  const prompt = text.trim();
  if (!prompt) return;

  hideEmptyState();
  appendUserTurn(prompt);
  state.turn = createAssistantTurn();
  state.turn.showThinking("正在启动 Codex…");
  setRunning(true);

  let res;
  try {
    res = await api("/api/run", {
      method: "POST",
      body: JSON.stringify({
        prompt,
        cwd: state.cwd,
        threadId: state.threadId,
        model: state.model,
        sandbox: state.sandbox,
      }),
    });
  } catch (err) {
    state.turn.addError(`请求失败：${err.message}`);
    setRunning(false);
    return;
  }

  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => ({}));
    state.turn.addError(data.error || `服务端返回 ${res.status}`);
    state.turn.finish();
    setRunning(false);
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index;
      while ((index = buffer.indexOf("\n\n")) >= 0) {
        const chunk = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        for (const line of chunk.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (!payload) continue;
          try {
            handleEvent(JSON.parse(payload));
          } catch {
            /* ignore malformed frame */
          }
        }
      }
    }
  } catch (err) {
    state.turn?.addError(`连接中断：${err.message}`);
  } finally {
    state.turn?.clearThinking();
    state.turn?.finish();
    // 兜底：SSE 中断也要给出「已回答完/已结束」的标签提示
    if (!state.runNotified) {
      state.runNotified = true;
      flashTabOnce();
    }
    setRunning(false);
    state.runId = null;
    loadThreads();
  }
}

els.composer.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = els.promptInput.value;
  if (!text.trim()) return;
  els.promptInput.value = "";
  autoGrow();
  sendPrompt(text);
});

els.promptInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    els.composer.requestSubmit();
  }
});

function autoGrow() {
  els.promptInput.style.height = "auto";
  els.promptInput.style.height = `${Math.min(els.promptInput.scrollHeight, 220)}px`;
}
els.promptInput.addEventListener("input", autoGrow);

els.stopBtn.addEventListener("click", async () => {
  if (!state.runId) return;
  await api("/api/stop", { method: "POST", body: JSON.stringify({ runId: state.runId }) });
  toast("已请求停止");
});

$$(".suggestions button").forEach((button) => {
  button.addEventListener("click", () => sendPrompt(button.dataset.prompt || ""));
});

els.sidebarToggle.addEventListener("click", () => els.app.classList.toggle("collapsed"));

els.modelSelect.addEventListener("change", (event) => {
  state.model = event.target.value;
});
els.sandboxSelect.addEventListener("change", (event) => {
  state.sandbox = event.target.value;
});

// ------------------------------------------------------------------ cwd picker

let cwdCurrent = "/root";

async function loadCwd(target) {
  try {
    const res = await api(`/api/fs?path=${encodeURIComponent(target)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "读取失败");
    cwdCurrent = data.path;
    els.cwdPath.value = data.path;
    els.cwdList.innerHTML = "";
    for (const entry of data.items) {
      if (!entry.dir && entry.name.startsWith(".")) continue;
      const row = document.createElement("button");
      row.className = "cwd-row";
      row.innerHTML = `<span>${entry.dir ? "📁" : "📄"}</span><span>${escapeHtml(entry.name)}</span>
        <span class="size">${entry.dir ? "" : formatBytes(entry.size)}</span>`;
      row.addEventListener("click", () => {
        if (entry.dir) loadCwd(entry.path);
        else els.cwdHint.textContent = entry.path;
      });
      els.cwdList.appendChild(row);
    }
    els.cwdUp.disabled = data.path === "/";
    els.cwdUp.onclick = () => loadCwd(data.parent);
    els.cwdHint.textContent = `${data.items.length} 项`;
  } catch (err) {
    toast(`目录读取失败：${err.message}`);
  }
}

els.cwdBtn.addEventListener("click", () => {
  els.cwdModal.classList.remove("hidden");
  loadCwd(state.cwd);
});
els.cwdClose.addEventListener("click", () => els.cwdModal.classList.add("hidden"));
els.cwdModal.addEventListener("click", (event) => {
  if (event.target === els.cwdModal) els.cwdModal.classList.add("hidden");
});
els.cwdGo.addEventListener("click", () => loadCwd(els.cwdPath.value.trim()));
els.cwdPath.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    loadCwd(els.cwdPath.value.trim());
  }
});
els.cwdPick.addEventListener("click", () => {
  state.cwd = cwdCurrent;
  localStorage.setItem("codex-cwd", state.cwd);
  els.cwdLabel.textContent = state.cwd;
  els.emptyCwd.textContent = state.cwd;
  els.cwdModal.classList.add("hidden");
  toast(`工作目录已设为 ${state.cwd}`);
});

// ------------------------------------------------------------------ password

// forced = true 时表示「还没改密码，别的功能都不能用」，不允许关闭
function openPasswordModal(forced = false) {
  if (forced) state.mustChangePassword = true;
  els.pwdForm.reset();
  els.pwdError.classList.add("hidden");
  els.pwdNotice.classList.toggle("hidden", !state.mustChangePassword);
  els.pwdClose.classList.toggle("hidden", state.mustChangePassword);
  els.pwdModal.classList.remove("hidden");
  els.pwdCurrent.focus();
}

function closePasswordModal() {
  if (state.mustChangePassword) return; // 强制改密时只能改完再关
  els.pwdModal.classList.add("hidden");
}

els.pwdClose.addEventListener("click", closePasswordModal);
els.pwdModal.addEventListener("click", (event) => {
  if (event.target === els.pwdModal) closePasswordModal();
});

els.pwdForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  els.pwdError.classList.add("hidden");

  const currentPassword = els.pwdCurrent.value;
  const newPassword = els.pwdNew.value;
  if (newPassword !== els.pwdConfirm.value) {
    els.pwdError.textContent = "两次输入的新密码不一致";
    els.pwdError.classList.remove("hidden");
    return;
  }

  const submit = els.pwdForm.querySelector("button[type=submit]");
  submit.disabled = true;
  try {
    const res = await api("/api/password", {
      method: "POST",
      body: JSON.stringify({ currentPassword, newPassword }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      els.pwdError.textContent = data.error || "修改失败";
      els.pwdError.classList.remove("hidden");
      return;
    }
    els.pwdModal.classList.add("hidden");
    els.pwdForm.reset();
    state.mustChangePassword = false;
    els.pwdNotice.classList.add("hidden");
    els.pwdClose.classList.remove("hidden");
    toast(data.message || "密码已更新");
    // 改密会让本账号其他设备的登录失效，这里直接重新登录一次最干净
    setTimeout(() => location.reload(), 1200);
  } catch (err) {
    els.pwdError.textContent = `网络错误：${err.message}`;
    els.pwdError.classList.remove("hidden");
  } finally {
    submit.disabled = false;
  }
});

// ------------------------------------------------------------------ 账号与权限（管理员）

let usersCache = [];
let editingUser = null;

function openUsersModal() {
  els.usersModal.classList.remove("hidden");
  closeUserForm();
  loadUsers();
}

function closeUserForm() {
  editingUser = null;
  els.userForm.classList.add("hidden");
  els.userFormError.classList.add("hidden");
  els.userForm.reset();
}

async function loadUsers() {
  els.usersHint.textContent = "加载中…";
  try {
    const res = await api("/api/admin/users");
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      els.usersHint.textContent = data.error || "加载失败";
      els.usersList.innerHTML = "";
      return;
    }
    usersCache = data.users || [];
    renderUsers();
  } catch (err) {
    els.usersHint.textContent = `加载失败：${err.message}`;
  }
}

function describePermissions(perms = {}) {
  if (perms.manageUsers && perms.threadsAll) return "全部权限";
  const parts = [];
  if (perms.run) parts.push("提交任务");
  if (perms.browse) parts.push("浏览目录");
  if (perms.threads) parts.push(perms.threadsAll ? "全部会话" : "自己的会话");
  else parts.push("看不到会话");
  if (perms.manageUsers) parts.push("账号管理");
  if (!parts.length) parts.push("无");
  return parts.join(" · ");
}

function renderUsers() {
  els.usersHint.textContent = `共 ${usersCache.length} 个账号`;
  els.usersList.innerHTML = "";
  for (const user of usersCache) {
    const perms = user.permissions || {};
    const isSelf = user.username === state.username;
    const row = document.createElement("div");
    row.className = `user-row${user.disabled ? " disabled" : ""}`;
    row.innerHTML = `
      <div class="user-main">
        <div class="user-line">
          <span class="avatar small">${escapeHtml(user.username.slice(0, 1).toUpperCase())}</span>
          <strong>${escapeHtml(user.displayName || user.username)}</strong>
          <code>${escapeHtml(user.username)}</code>
          ${user.role === "admin" ? '<span class="tag admin">管理员</span>' : '<span class="tag">成员</span>'}
          ${isSelf ? '<span class="tag me">当前登录</span>' : ""}
          ${user.mustChangePassword ? '<span class="tag off">需改密码</span>' : ""}
          ${user.disabled ? '<span class="tag off">已禁用</span>' : ""}
        </div>
        <div class="user-meta">
          <span>权限上限：${escapeHtml(SANDBOX_LABEL[perms.sandboxMax] || perms.sandboxMax || "-")}</span>
          <span>${escapeHtml(describePermissions(perms))}</span>
          <span>工作目录：${escapeHtml(perms.defaultCwd || "-")}</span>
        </div>
        <div class="user-meta muted">
          <span>创建：${escapeHtml((user.createdAt || "").slice(0, 10) || "-")}</span>
          <span>最近登录：${escapeHtml(user.lastLoginAt ? relativeTime(user.lastLoginAt) : "从未")}</span>
        </div>
      </div>
      <div class="user-actions">
        <button class="ghost-btn" data-act="edit">编辑</button>
        <button class="ghost-btn" data-act="signout" title="让该账号在所有设备上退出登录">强制下线</button>
        <button class="ghost-btn danger" data-act="delete" ${isSelf ? "disabled" : ""}>删除</button>
      </div>`;
    row.querySelector('[data-act="edit"]').addEventListener("click", () => openUserForm(user));
    row.querySelector('[data-act="signout"]').addEventListener("click", () => signOutUser(user));
    row.querySelector('[data-act="delete"]').addEventListener("click", () => deleteUser(user));
    els.usersList.appendChild(row);
  }
}

function syncUserFormRole() {
  const isAdmin = els.ufRole.value === "admin";
  for (const box of [els.ufRun, els.ufBrowse, els.ufThreads, els.ufThreadsAll, els.ufManage]) {
    box.disabled = isAdmin;
    if (isAdmin) box.checked = true;
  }
  els.ufSandbox.disabled = isAdmin;
  if (isAdmin) els.ufSandbox.value = "danger-full-access";
  els.ufCwd.disabled = false;
  els.userFormNote.textContent = isAdmin
    ? "管理员自动拥有全部权限，无法单独取消"
    : "「浏览目录」关闭后，该账号只能在默认工作目录里运行任务";
}

function openUserForm(user) {
  editingUser = user || null;
  els.userFormError.classList.add("hidden");
  els.userForm.classList.remove("hidden");
  const perms = user?.permissions || {
    run: true,
    browse: false,
    threads: true,
    threadsAll: false,
    manageUsers: false,
    sandboxMax: "workspace-write",
    defaultCwd: "/root",
  };

  els.userFormTitle.textContent = user ? `编辑账号 ${user.username}` : "新增账号";
  els.ufUsername.value = user?.username || "";
  els.ufUsername.disabled = Boolean(user);
  els.ufDisplay.value = user?.displayName || "";
  els.ufPassword.value = "";
  els.ufPasswordLabel.textContent = user ? "重置密码（留空表示不修改）" : "密码（至少 8 位）";
  els.ufRole.value = user?.role || "member";
  els.ufSandbox.value = perms.sandboxMax || "workspace-write";
  els.ufCwd.value = perms.defaultCwd || "/root";
  els.ufRun.checked = perms.run !== false;
  els.ufBrowse.checked = Boolean(perms.browse);
  els.ufThreads.checked = perms.threads !== false;
  els.ufThreadsAll.checked = Boolean(perms.threadsAll);
  els.ufManage.checked = Boolean(perms.manageUsers);
  // 新账号默认要求首次登录改密码；编辑时反映当前状态
  els.ufMustChange.checked = user ? Boolean(user.mustChangePassword) : true;
  els.ufDisabled.checked = Boolean(user?.disabled);
  els.ufDisabled.disabled = user?.username === state.username;
  syncUserFormRole();
  els.ufDisplay.focus();
}

async function signOutUser(user) {
  if (!confirm(`让「${user.username}」在所有设备上退出登录？`)) return;
  const res = await api(`/api/admin/users/${encodeURIComponent(user.username)}`, {
    method: "POST",
    body: JSON.stringify({ signOutAll: true }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return toast(data.error || "操作失败");
  toast(`${user.username} 已被强制下线`);
  if (user.username === state.username) location.reload();
}

async function deleteUser(user) {
  if (!confirm(`确定删除账号「${user.username}」？该账号将立即无法登录。`)) return;
  const res = await api(`/api/admin/users/${encodeURIComponent(user.username)}/delete`, {
    method: "POST",
    body: JSON.stringify({}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return toast(data.error || "删除失败");
  toast(`已删除账号 ${user.username}`);
  if (editingUser?.username === user.username) closeUserForm();
  loadUsers();
}

els.usersClose.addEventListener("click", () => els.usersModal.classList.add("hidden"));
els.usersModal.addEventListener("click", (event) => {
  if (event.target === els.usersModal) els.usersModal.classList.add("hidden");
});
els.userNewBtn.addEventListener("click", () => openUserForm(null));
els.userFormClose.addEventListener("click", closeUserForm);
els.ufRole.addEventListener("change", syncUserFormRole);

els.userForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  els.userFormError.classList.add("hidden");

  const password = els.ufPassword.value;
  const payload = {
    displayName: els.ufDisplay.value.trim(),
    role: els.ufRole.value,
    disabled: els.ufDisabled.checked,
    mustChangePassword: els.ufMustChange.checked,
    permissions: {
      run: els.ufRun.checked,
      browse: els.ufBrowse.checked,
      threads: els.ufThreads.checked,
      threadsAll: els.ufThreadsAll.checked,
      manageUsers: els.ufManage.checked,
      sandboxMax: els.ufSandbox.value,
      defaultCwd: els.ufCwd.value.trim() || "/root",
    },
  };

  if (!editingUser && password.length < 8) {
    els.userFormError.textContent = "新账号的密码至少 8 位";
    els.userFormError.classList.remove("hidden");
    return;
  }
  if (editingUser && password && password.length < 8) {
    els.userFormError.textContent = "新密码至少 8 位";
    els.userFormError.classList.remove("hidden");
    return;
  }

  const submit = els.userForm.querySelector("button[type=submit]");
  submit.disabled = true;
  try {
    let res;
    if (editingUser) {
      if (password) payload.password = password;
      res = await api(`/api/admin/users/${encodeURIComponent(editingUser.username)}`, {
        method: "POST",
        body: JSON.stringify(payload),
      });
    } else {
      payload.username = els.ufUsername.value.trim();
      payload.password = password;
      res = await api("/api/admin/users", { method: "POST", body: JSON.stringify(payload) });
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      els.userFormError.textContent = data.error || "保存失败";
      els.userFormError.classList.remove("hidden");
      return;
    }

    const selfAffected = editingUser?.username === state.username;
    closeUserForm();
    await loadUsers();
    if (selfAffected && (password || els.ufDisabled.checked)) {
      toast("已更新，请重新登录");
      setTimeout(() => location.reload(), 1200);
      return;
    }
    toast(editingUser ? `已更新账号 ${editingUser.username}` : `已创建账号 ${data.user?.username || ""}`);
  } catch (err) {
    els.userFormError.textContent = `网络错误：${err.message}`;
    els.userFormError.classList.remove("hidden");
  } finally {
    submit.disabled = false;
  }
});

// ------------------------------------------------------------------ boot

// ------------------------------------------------------------------ 模型与 API Key

let providersCache = [];
let editingProvider = null;

function openModelsModal() {
  els.modelsModal.classList.remove("hidden");
  closeModelForm();
  loadProviders();
}

function closeModelForm() {
  editingProvider = null;
  els.modelForm.classList.add("hidden");
  els.modelFormError.classList.add("hidden");
  els.modelForm.reset();
}

async function loadProviders() {
  els.modelsHint.textContent = "加载中…";
  try {
    const res = await api("/api/admin/models");
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      els.modelsHint.textContent = data.error || "加载失败";
      els.modelsList.innerHTML = "";
      return;
    }
    providersCache = data.providers || [];
    renderProviders();
  } catch (err) {
    els.modelsHint.textContent = `加载失败：${err.message}`;
  }
}

function keyBadge(provider) {
  if (provider.apiKeyMask) return `<span class="tag me">密钥 ${escapeHtml(provider.apiKeyMask)}</span>`;
  if (provider.keyFromEnv) return `<span class="tag me">环境变量 ${escapeHtml(provider.envKey)}</span>`;
  return '<span class="tag off">未配置密钥</span>';
}

function renderProviders() {
  els.modelsHint.textContent = `共 ${providersCache.length} 个供应商`;
  els.modelsList.innerHTML = "";
  if (!providersCache.length) {
    els.modelsList.innerHTML =
      '<div class="empty-hint">还没有配置模型供应商。点击「新增供应商」填写 DeepSeek / OpenAI / 其他 OpenAI 兼容服务的 Base URL 与 API Key。</div>';
    return;
  }
  for (const provider of providersCache) {
    const row = document.createElement("div");
    row.className = "user-row";
    row.innerHTML = `
      <div class="user-main">
        <div class="user-line">
          <strong>${escapeHtml(provider.name || provider.id)}</strong>
          <code>${escapeHtml(provider.id)}</code>
          ${provider.active ? '<span class="tag admin">默认</span>' : '<span class="tag">备用</span>'}
          ${keyBadge(provider)}
        </div>
        <div class="user-meta">
          <span>base_url：${escapeHtml(provider.baseUrl || "-")}</span>
          <span>接口：${escapeHtml(provider.wireApi)}</span>
          <span>密钥环境变量：${escapeHtml(provider.envKey)}</span>
        </div>
        <div class="user-meta muted">
          <span>模型：${escapeHtml((provider.models || []).join(", ") || "-")}</span>
          <span>默认：${escapeHtml(provider.defaultModel || "-")}</span>
          ${provider.reasoningEffort ? `<span>推理：${escapeHtml(provider.reasoningEffort)}</span>` : ""}
        </div>
      </div>
      <div class="user-actions">
        <button class="ghost-btn" data-act="edit">编辑</button>
        <button class="ghost-btn" data-act="test">测试连接</button>
        <button class="ghost-btn" data-act="activate" ${provider.active ? "disabled" : ""}>设为默认</button>
        <button class="ghost-btn" data-act="clear" ${provider.apiKeyMask ? "" : "disabled"}>清除密钥</button>
        <button class="ghost-btn danger" data-act="delete">删除</button>
      </div>`;
    row.querySelector('[data-act="edit"]').addEventListener("click", () => openModelForm(provider));
    row.querySelector('[data-act="test"]').addEventListener("click", (event) => testProvider(provider, event.target));
    row.querySelector('[data-act="activate"]').addEventListener("click", () => activateProvider(provider));
    row.querySelector('[data-act="clear"]').addEventListener("click", () => clearProviderKey(provider));
    row.querySelector('[data-act="delete"]').addEventListener("click", () => deleteProvider(provider));
    els.modelsList.appendChild(row);
  }
}

function openModelForm(provider) {
  editingProvider = provider || null;
  els.modelFormError.classList.add("hidden");
  els.modelForm.classList.remove("hidden");
  els.modelFormTitle.textContent = provider ? `编辑供应商 ${provider.id}` : "新增供应商";
  els.mfId.value = provider?.id || "";
  els.mfId.disabled = Boolean(provider);
  els.mfName.value = provider?.name || "";
  els.mfBaseUrl.value = provider?.baseUrl || "";
  els.mfWireApi.value = provider?.wireApi || "responses";
  els.mfEnvKey.value = provider?.envKey || "";
  els.mfApiKey.value = "";
  els.mfApiKeyLabel.textContent = provider?.apiKeyMask
    ? `API Key（当前 ${provider.apiKeyMask}，留空表示不修改）`
    : "API Key（加密保存，留空表示不修改）";
  els.mfModels.value = (provider?.models || []).join(", ");
  els.mfDefault.value = provider?.defaultModel || "";
  els.mfCatalog.value = provider?.modelCatalog || "";
  els.mfReasoning.value = provider?.reasoningEffort || "";
  els.mfActive.checked = Boolean(provider?.active) || !providersCache.length;
  els.mfNoSave.checked = Boolean(provider && !provider.apiKeyMask && provider.keyFromEnv);
  els.modelFormNote.textContent = provider
    ? "留空 API Key 表示沿用已保存的密钥"
    : "保存后即可在右上角模型下拉框里选择该供应商的模型";
  els.mfName.focus();
}

async function testProvider(provider, button) {
  const original = button?.textContent;
  if (button) {
    button.disabled = true;
    button.textContent = "测试中…";
  }
  try {
    const res = await api(`/api/admin/models/${encodeURIComponent(provider.id)}/test`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return toast(data.error || "测试失败");
    const result = data.result || {};
    if (result.ok) toast(`连接正常：${result.message || `HTTP ${result.status}`}`);
    else toast(`测试未通过：${result.message || result.error || `HTTP ${result.status || "-"}`}`);
  } catch (err) {
    toast(`测试失败：${err.message}`);
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = original;
    }
  }
}

async function activateProvider(provider) {
  const res = await api(`/api/admin/models/${encodeURIComponent(provider.id)}/activate`, {
    method: "POST",
    body: JSON.stringify({}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return toast(data.error || "操作失败");
  toast(`${provider.id} 已设为默认供应商`);
  await loadProviders();
  refreshSession();
}

async function clearProviderKey(provider) {
  if (!confirm(`清除「${provider.id}」保存的 API Key？清除后该供应商将只能从环境变量 ${provider.envKey} 读取密钥。`)) return;
  const res = await api(`/api/admin/models/${encodeURIComponent(provider.id)}/clear-key`, {
    method: "POST",
    body: JSON.stringify({}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return toast(data.error || "操作失败");
  toast(`已清除 ${provider.id} 的密钥`);
  loadProviders();
}

async function deleteProvider(provider) {
  if (!confirm(`确定删除供应商「${provider.id}」？密码之外的配置与已保存密钥都会被删除。`)) return;
  const res = await api(`/api/admin/models/${encodeURIComponent(provider.id)}/delete`, {
    method: "POST",
    body: JSON.stringify({}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return toast(data.error || "删除失败");
  toast(`已删除供应商 ${provider.id}`);
  if (editingProvider?.id === provider.id) closeModelForm();
  await loadProviders();
  refreshSession();
}

els.modelsClose.addEventListener("click", () => els.modelsModal.classList.add("hidden"));
els.modelsModal.addEventListener("click", (event) => {
  if (event.target === els.modelsModal) els.modelsModal.classList.add("hidden");
});
els.modelNewBtn.addEventListener("click", () => openModelForm(null));
els.modelFormClose.addEventListener("click", closeModelForm);

els.modelForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  els.modelFormError.classList.add("hidden");

  const id = (editingProvider?.id || els.mfId.value.trim()).toLowerCase();
  if (!/^[a-z0-9_-]{2,40}$/.test(id)) {
    els.modelFormError.textContent = "供应商 ID 需为 2-40 位小写字母、数字、短横线或下划线";
    els.modelFormError.classList.remove("hidden");
    return;
  }
  if (!els.mfBaseUrl.value.trim()) {
    els.modelFormError.textContent = "API Base URL 不能为空";
    els.modelFormError.classList.remove("hidden");
    return;
  }
  const apiKey = els.mfApiKey.value.trim();
  const noSave = els.mfNoSave.checked;
  const payload = {
    id,
    name: els.mfName.value.trim() || id,
    baseUrl: els.mfBaseUrl.value.trim(),
    wireApi: els.mfWireApi.value,
    envKey: els.mfEnvKey.value.trim(),
    models: els.mfModels.value
      .split(/[\s,]+/)
      .map((item) => item.trim())
      .filter(Boolean),
    defaultModel: els.mfDefault.value.trim(),
    modelCatalog: els.mfCatalog.value.trim(),
    reasoningEffort: els.mfReasoning.value,
    active: els.mfActive.checked,
    apiKey: noSave ? "" : apiKey,
  };
  if (editingProvider && noSave && editingProvider.apiKeyMask) payload.clearApiKey = true;

  const isEdit = Boolean(editingProvider);
  const submit = els.modelForm.querySelector("button[type=submit]");
  submit.disabled = true;
  try {
    const res = await api("/api/admin/models", { method: "POST", body: JSON.stringify(payload) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      els.modelFormError.textContent = data.error || "保存失败";
      els.modelFormError.classList.remove("hidden");
      return;
    }
    closeModelForm();
    await loadProviders();
    refreshSession();
    toast(isEdit ? `已更新供应商 ${id}` : `已新增供应商 ${id}`);
  } catch (err) {
    els.modelFormError.textContent = `网络错误：${err.message}`;
    els.modelFormError.classList.remove("hidden");
  } finally {
    submit.disabled = false;
  }
});

// ------------------------------------------------------------------ 本机权限与审计

function openPolicyModal() {
  els.policyModal.classList.remove("hidden");
  loadPolicy();
}

async function loadPolicy() {
  els.policyHint.textContent = "加载中…";
  try {
    const res = await api("/api/admin/policy");
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      els.policyHint.textContent = data.error || "加载失败";
      return;
    }
    const policy = data.policy || {};
    els.pfEnabled.checked = policy.enabled !== false;
    els.pfNetwork.checked = policy.allowNetwork !== false;
    els.pfAudit.checked = policy.audit !== false;
    els.pfRoots.value = (policy.allowedRoots || []).join("\n");
    els.pfBrowse.value = (policy.browseRoots || []).join("\n");
    els.pfDeny.value = (policy.denyCommands || []).join("\n");
    els.pfProtect.value = (policy.protectPaths || []).join("\n");
    els.pfMaxMinutes.value = policy.maxRunMinutes || 0;
    els.pfGlobalRuns.value = data.maxConcurrentRuns || 3;
    els.pfUserRuns.value = data.maxConcurrentRunsPerUser || 2;
    els.policyHint.textContent = `Codex 可执行文件：${data.codexBin || "-"}`;
    renderAudit(data.audit || []);
  } catch (err) {
    els.policyHint.textContent = `加载失败：${err.message}`;
  }
}

function renderAudit(entries) {
  els.auditList.innerHTML = "";
  if (!entries.length) {
    els.auditList.innerHTML = '<div class="empty-hint">还没有审计记录（开启审计并运行任务后，这里会显示每次任务的目录、模型与结果）。</div>';
    return;
  }
  for (const entry of entries) {
    const row = document.createElement("div");
    row.className = `audit-row${entry.blockedReason ? " blocked" : ""}`;
    if (entry.event === "policy.updated") {
      row.innerHTML = `<span class="audit-time">${escapeHtml(relativeTime(entry.at))}</span>
        <span class="audit-main">策略更新 by <strong>${escapeHtml(entry.user || "-")}</strong></span>`;
      els.auditList.appendChild(row);
      continue;
    }
    const ok = entry.exitCode === 0 && !entry.blockedReason;
    const status = entry.blockedReason
      ? entry.blockedReason === "timeout"
        ? "超时终止"
        : "被策略拦截"
      : ok
        ? "完成"
        : `退出码 ${entry.exitCode}`;
    const violation = (entry.violations || [])[0];
    row.innerHTML = `
      <span class="audit-time">${escapeHtml(relativeTime(entry.at))}</span>
      <span class="audit-main">
        <strong>${escapeHtml(entry.user || "-")}</strong>
        <code>${escapeHtml(entry.model || "-")}</code>
        <code>${escapeHtml(entry.cwd || "-")}</code>
        <span class="audit-status ${ok ? "ok" : "bad"}">${escapeHtml(status)}</span>
      </span>
      <span class="audit-detail">${escapeHtml(violation ? `${violation.kind === "path" ? "路径" : "命令"}：${violation.detail || violation.pattern}` : entry.prompt || "")}</span>`;
    els.auditList.appendChild(row);
  }
}

els.policyClose.addEventListener("click", () => els.policyModal.classList.add("hidden"));
els.policyModal.addEventListener("click", (event) => {
  if (event.target === els.policyModal) els.policyModal.classList.add("hidden");
});

els.policyForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  els.policyError.classList.add("hidden");
  const lines = (value) =>
    String(value || "")
      .split("\n")
      .map((item) => item.trim())
      .filter(Boolean);
  const payload = {
    policy: {
      enabled: els.pfEnabled.checked,
      allowNetwork: els.pfNetwork.checked,
      audit: els.pfAudit.checked,
      allowedRoots: lines(els.pfRoots.value),
      browseRoots: lines(els.pfBrowse.value),
      denyCommands: lines(els.pfDeny.value),
      protectPaths: lines(els.pfProtect.value),
      maxRunMinutes: Number(els.pfMaxMinutes.value) || 0,
    },
    limits: {
      maxConcurrentRuns: Number(els.pfGlobalRuns.value) || 1,
      maxConcurrentRunsPerUser: Number(els.pfUserRuns.value) || 1,
    },
  };
  const submit = els.policyForm.querySelector("button[type=submit]");
  submit.disabled = true;
  try {
    const res = await api("/api/admin/policy", { method: "POST", body: JSON.stringify(payload) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      els.policyError.textContent = data.error || "保存失败";
      els.policyError.classList.remove("hidden");
      return;
    }
    toast("本机权限策略已保存");
    refreshSession();
    await loadPolicy();
  } catch (err) {
    els.policyError.textContent = `网络错误：${err.message}`;
    els.policyError.classList.remove("hidden");
  } finally {
    submit.disabled = false;
  }
});

// 管理员改完配置后同步刷新当前会话（模型下拉框、权限提示等）
async function refreshSession() {
  try {
    const res = await api("/api/session");
    if (!res.ok) return;
    const session = await res.json();
    state.permissions = session.permissions || state.permissions;
    state.policy = session.policy || state.policy;
    state.model = session.model || "";
    populateModelSelect(session);
    applyPermissions(session);
  } catch {
    /* 忽略：下次刷新页面会重新拉取 */
  }
}

boot();
