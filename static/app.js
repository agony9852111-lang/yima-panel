const $ = (id) => document.getElementById(id);
const STORAGE_KEY = "yima_panel_config";

let jobRunning = false;
let stopRequested = false;
let roundCounter = 0;
let inFlight = 0;
const stats = { phoneOk: 0, smsOk: 0, cycles: 0 };

function cfg() {
  return {
    root_domain: $("rootDomain").value.trim() || "ejiema.com",
    token: $("token").value.trim(),
  };
}

function hasToken() {
  return Boolean(cfg().token);
}

function loadConfig() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    if (data.root_domain) $("rootDomain").value = data.root_domain;
    if (data.token) $("token").value = data.token;
  } catch (_) {
    /* ignore */
  }
}

function saveConfig() {
  const c = cfg();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(c));
  syncTokenGate();
  $("balanceBox").textContent = c.token ? "配置已保存" : "Token 为空，未保存有效配置";
}

function requireToken() {
  const c = cfg();
  if (!c.token) {
    alert("请先到「02 个人中心」配置 API Token");
    goPage("account");
    throw new Error("no token");
  }
  return c;
}

function setOut(el, obj) {
  el.textContent = typeof obj === "string" ? obj : JSON.stringify(obj, null, 2);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function post(path, body) {
  const r = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const detail = data.detail;
    const msg = Array.isArray(detail)
      ? detail.map((d) => d.msg || JSON.stringify(d)).join("; ")
      : detail || data.message || `HTTP ${r.status}`;
    throw new Error(msg);
  }
  return data;
}

function updateApiPreview() {
  const d = ($("rootDomain").value.trim() || "ejiema.com")
    .replace(/^https?:\/\//, "")
    .replace(/^(www|app|api)\./, "");
  $("apiBasePreview").textContent = `https://api.${d}/zc/data.php`;
}

function goPage(page) {
  document.querySelectorAll(".nav-item").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.page === page);
  });
  document.querySelectorAll(".page").forEach((el) => {
    el.classList.toggle("active", el.id === `page-${page}`);
  });
}

function syncTokenGate() {
  const ok = hasToken();
  const gate = $("tokenGate");
  const card = $("randomCard");
  const tokenState = $("tokenState");
  const btn = $("btnRandomJob");
  const stopBtn = $("btnStopJob");

  if (ok) {
    gate.style.display = "none";
    card.classList.remove("token-locked");
    tokenState.textContent = "Token 已配置";
    tokenState.classList.remove("soft");
    tokenState.classList.add("ok");
    if (!jobRunning) {
      btn.disabled = false;
      stopBtn.disabled = true;
      $("flowState").textContent = "就绪";
    }
    if ($("randLog").textContent.includes("配置 Token") || $("randLog").textContent.includes("说明：")) {
      $("randLog").textContent =
        "Token 已就绪。并发只限制「同时跑几条」，总次数不限：取号→查短信→再开新任务，直到停止。";
    }
  } else {
    gate.style.display = "grid";
    card.classList.add("token-locked");
    tokenState.textContent = "Token 未配置";
    tokenState.classList.add("soft");
    tokenState.classList.remove("ok");
    btn.disabled = true;
    stopBtn.disabled = true;
    $("flowState").textContent = "先配置 Token";
  }
}

function setRunning(running) {
  jobRunning = running;
  $("btnRandomJob").disabled = running || !hasToken();
  $("btnStopJob").disabled = !running;
  if (!running && hasToken()) $("flowState").textContent = "就绪";
}

function keywords() {
  return $("randKeywords").value
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function pickKeyword(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function refreshStatsUI(extra) {
  const rate = stats.phoneOk > 0 ? Math.round((stats.smsOk / stats.phoneOk) * 100) : 0;
  const pulse = jobRunning ? ((stats.cycles * 17 + stats.phoneOk * 11 + inFlight * 3) % 35) : 0;
  const width = jobRunning ? Math.min(96, Math.max(12, rate * 0.7 + 18 + pulse)) : rate;

  $("statCycles").textContent = String(stats.cycles);
  $("statPhone").textContent = String(stats.phoneOk);
  $("statSms").textContent = String(stats.smsOk);
  $("statRate").textContent = `${rate}%`;
  $("progressBar").style.width = `${width}%`;
  $("progressLabel").textContent = jobRunning
    ? extra || `进行中 ${inFlight} · 累计轮次不限`
    : stats.cycles
      ? `已停止 · 累计轮次 ${stats.cycles}`
      : "未启动";

  $("progressPanel").classList.toggle("running", jobRunning);
  const countEl = $("resultsCount");
  if (countEl) countEl.textContent = `${$("randResults").children.length} 条`;
}

function updateStatus(extra) {
  $("flowState").textContent = jobRunning ? `运行中 · 并发 ${inFlight}` : "就绪";
  $("randLog").textContent =
    `持续运行中 · 当前进行 ${inFlight} · 累计轮次 ${stats.cycles} · 取号 ${stats.phoneOk} · 短信查询 ${stats.smsOk}` +
    (extra ? ` · ${extra}` : "");
  refreshStatsUI(extra);
}

function appendResult(item) {
  const box = $("randResults");
  const el = document.createElement("div");
  el.className = `card-res ${item.ok ? "ok" : "bad"}`;
  el.innerHTML = `<div class="t">${item.title}</div><pre>${item.detail}</pre>`;
  box.prepend(el);
  while (box.children.length > 80) box.removeChild(box.lastChild);
  refreshStatsUI();
  box.scrollTop = 0;
}

/** 单个完整周期：无限轮询取号 → 查短信一次 → 结束（由调度器再开新周期） */
async function runCycle(c, getInterval, msgInterval) {
  const round = ++roundCounter;
  const kws = keywords();
  if (!kws.length) {
    await sleep(500);
    return;
  }

  const key_word = pickKeyword(kws);
  let phone = "";
  let attempt = 0;

  while (!stopRequested && !phone) {
    attempt += 1;
    updateStatus(`#${round} 「${key_word}」取号第 ${attempt} 次`);

    if (getInterval > 0 && attempt > 1) {
      await sleep(getInterval * 1000);
      if (stopRequested) return;
    }

    try {
      const phoneRes = await post("/api/get-phone", {
        ...c,
        key_word,
        phone: "",
        province: "",
        card_type: "全部",
      });
      if (phoneRes.ok && phoneRes.phone) phone = String(phoneRes.phone).trim();
    } catch (_) {
      /* 继续取号，次数不限 */
    }
  }

  if (stopRequested || !phone) return;

  stats.phoneOk += 1;

  if (msgInterval > 0) {
    updateStatus(`#${round} 已取号 ${phone}，查询间隔 ${msgInterval}s`);
    await sleep(msgInterval * 1000);
    if (stopRequested) return;
  }

  updateStatus(`#${round} ${phone} 查询短信接口`);
  let smsRes = null;
  let queryOk = false;
  try {
    smsRes = await post("/api/get-msg", { ...c, phone, key_word });
    queryOk = Boolean(smsRes && smsRes.ok);
  } catch (e) {
    smsRes = { ok: false, raw: String(e.message || e) };
  }

  if (queryOk) stats.smsOk += 1;
  stats.cycles += 1;

  appendResult({
    ok: queryOk,
    title: queryOk
      ? `轮次#${round} 查短信完成 · ${phone}${smsRes && smsRes.pending ? "（尚未收到内容）" : ""}`
      : `轮次#${round} 查短信失败 · ${phone}`,
    detail: JSON.stringify({ key_word, phone, phone_attempts: attempt, sms: smsRes }, null, 2),
  });
  updateStatus();
}

/** 调度器：并发只限制同时进行中的任务数，总轮次不限，直到停止 */
async function runPool(c, concurrency, getInterval, msgInterval) {
  const running = new Set();

  const spawn = () => {
    if (stopRequested) return;
    if (running.size >= concurrency) return;

    let task;
    task = (async () => {
      try {
        await runCycle(c, getInterval, msgInterval);
      } catch (e) {
        appendResult({
          ok: false,
          title: "任务异常",
          detail: String(e.message || e),
        });
      } finally {
        running.delete(task);
        inFlight = running.size;
        updateStatus();
        if (!stopRequested) spawn();
      }
    })();

    running.add(task);
    inFlight = running.size;
  };

  for (let i = 0; i < concurrency; i++) spawn();

  while (running.size > 0) {
    await sleep(120);
    if (!stopRequested) {
      while (running.size < concurrency && !stopRequested) spawn();
    }
  }
}

document.querySelectorAll(".nav-item").forEach((btn) => {
  btn.addEventListener("click", () => goPage(btn.dataset.page));
});

$("btnGoAccount").addEventListener("click", () => goPage("account"));
$("btnGoRandom").addEventListener("click", () => goPage("random"));

$("toggleToken").addEventListener("click", () => {
  const input = $("token");
  const show = input.type === "password";
  input.type = show ? "text" : "password";
  $("toggleToken").textContent = show ? "隐藏" : "显示";
});

$("rootDomain").addEventListener("input", updateApiPreview);
$("token").addEventListener("input", syncTokenGate);
$("btnSaveToken").addEventListener("click", saveConfig);

loadConfig();
updateApiPreview();
syncTokenGate();
refreshStatsUI();
goPage("random");

$("btnBalance").addEventListener("click", async () => {
  try {
    const c = requireToken();
    $("balanceBox").textContent = "查询中…";
    const data = await post("/api/balance", c);
    $("balanceBox").textContent = data.ok ? `余额：${data.balance}` : data.raw;
  } catch (e) {
    $("balanceBox").textContent = String(e.message || e);
  }
});

$("btnClearResults").addEventListener("click", () => {
  $("randResults").innerHTML = "";
  $("randLog").textContent = hasToken()
    ? jobRunning
      ? "结果已清空，任务仍在继续。"
      : "结果已清空。可再次启动持续任务。"
    : "请先配置 Token。";
  refreshStatsUI();
});

$("btnStopJob").addEventListener("click", () => {
  if (!jobRunning) return;
  stopRequested = true;
  $("randLog").textContent = "正在停止… 进行中的任务结束后不再新开。";
  $("flowState").textContent = "停止中";
  $("progressLabel").textContent = "停止中…";
});

$("btnRandomJob").addEventListener("click", async () => {
  const log = $("randLog");
  try {
    const c = requireToken();
    if (!keywords().length) return alert("请至少输入一个关键词");

    // 并发 = 同时进行中的最大任务数（资源），不是总次数上限
    const concurrency = Math.max(1, Math.min(100, Number($("randCount").value || 1)));
    const getInterval = Math.max(0, Number($("randGetInterval").value || 0));
    const msgInterval = Math.max(0, Number($("randMsgInterval").value || 0));

    stopRequested = false;
    roundCounter = 0;
    inFlight = 0;
    stats.phoneOk = 0;
    stats.smsOk = 0;
    stats.cycles = 0;
    setRunning(true);
    updateStatus(`已启动，最大并发 ${concurrency}（总次数不限）`);

    await runPool(c, concurrency, getInterval, msgInterval);

    log.textContent = `已停止。累计轮次 ${stats.cycles} · 取号 ${stats.phoneOk} · 短信查询 ${stats.smsOk}`;
    $("flowState").textContent = "已停止";
    refreshStatsUI("已停止");
  } catch (e) {
    setOut(log, String(e.message || e));
    $("flowState").textContent = "出错";
  } finally {
    stopRequested = false;
    inFlight = 0;
    setRunning(false);
    syncTokenGate();
    refreshStatsUI();
  }
});

(async function health() {
  const el = $("healthDot");
  try {
    const r = await fetch("/api/health");
    if (!r.ok) throw new Error("bad");
    el.textContent = "服务在线";
    el.classList.add("ok");
  } catch {
    el.textContent = "服务离线";
    el.classList.add("bad");
  }
})();
