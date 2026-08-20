(() => {
  "use strict";

  const DATA = "./data";
  const PROGRESS_KEY = "daguan_local_progress_v1";
  const MODE_KEY = "daguan_local_mode_v1";
  const PICK_KEY = "daguan_local_picked_v1";
  const PAGE_SIZE = 20;
  const TYPE_LABEL = {
    subjective: "主观题",
    single_choice: "单选",
    multiple_choice: "多选",
  };
  const MASTERY_LABEL = {
    not_started: "未开始",
    learning: "学习中",
    mastered: "已掌握",
    forgot: "易错",
  };

  const state = {
    manifest: null,
    categories: [],
    catQuestions: {},
    idIndex: {},
    searchIndex: null,
    shards: new Map(),
    queue: [],
    index: 0,
    showAnswer: false,
    selected: new Set(),
    // per-question UI in list mode: { showAnswer, selected:Set }
    cardUI: new Map(),
    progress: loadProgress(),
    currentCatId: null,
    crumb: "",
    filterCore: false,
    filterTodo: false,
    scope: "all", // all | core
    view: "home", // home | browse | search
    mode: loadMode(), // list | single
    renderedCount: 0,
    specialQueue: null, // null | 'todo' | 'forgot'
    picked: loadPicked(),
  };

  const $ = (sel) => document.querySelector(sel);
  const els = {
    sidebar: $("#sidebar"),
    catTree: $("#cat-tree"),
    stats: $("#stats-line"),
    crumb: $("#crumb"),
    home: $("#view-home"),
    browse: $("#view-browse"),
    searchView: $("#view-search"),
    homeCards: $("#home-cards"),
    search: $("#search"),
    searchResults: $("#search-results"),
    searchCount: $("#search-count"),
    listMode: $("#list-mode"),
    singleMode: $("#single-mode"),
    qFeed: $("#q-feed"),
    feedFoot: $("#feed-foot"),
    feedStatus: $("#feed-status"),
    loadMore: $("#btn-load-more"),
    browseHeading: $("#browse-heading"),
    browseSub: $("#browse-sub"),
    browseProgress: $("#browse-progress"),
    progressFill: $("#progress-fill"),
    progressLabel: $("#progress-label"),
    qPos: $("#q-pos"),
    qSource: $("#q-source"),
    qType: $("#q-type"),
    qId: $("#q-id"),
    qPath: $("#q-path"),
    qStem: $("#q-stem"),
    qOptions: $("#q-options"),
    qAnswer: $("#q-answer"),
    qExpl: $("#q-expl"),
    answerBox: $("#answer-box"),
    listStrip: $("#list-strip"),
    toast: $("#toast"),
    filterCore: $("#filter-core"),
    filterTodo: $("#filter-todo"),
    metricTotal: $("#metric-total"),
    metricSeen: $("#metric-seen"),
    metricMastered: $("#metric-mastered"),
    metricForgot: $("#metric-forgot"),
  };

  function loadProgress() {
    try {
      return JSON.parse(localStorage.getItem(PROGRESS_KEY) || "{}") || {};
    } catch {
      return {};
    }
  }

  function loadPicked() {
    try {
      const raw = JSON.parse(localStorage.getItem(PICK_KEY) || "[]");
      return new Set((Array.isArray(raw) ? raw : []).map(String));
    } catch {
      return new Set();
    }
  }

  function savePicked() {
    localStorage.setItem(PICK_KEY, JSON.stringify([...state.picked]));
    refreshPickUI();
  }

  function isPicked(id) {
    return state.picked.has(String(id));
  }

  function setPicked(id, on) {
    const key = String(id);
    if (on) state.picked.add(key);
    else state.picked.delete(key);
    savePicked();
  }

  function pickedIdsOrdered() {
    const seen = new Set();
    const out = [];
    for (const q of state.queue) {
      const id = String(q.id);
      if (state.picked.has(id) && !seen.has(id)) {
        out.push(id);
        seen.add(id);
      }
    }
    for (const id of state.picked) {
      if (!seen.has(id)) out.push(id);
    }
    return out;
  }

  function refreshPickUI() {
    const n = state.picked.size;
    const count = $("#pick-count");
    if (count) count.textContent = `已勾选 ${n} 题`;
    document.querySelectorAll("[data-pick-id]").forEach((el) => {
      el.checked = state.picked.has(String(el.dataset.pickId));
    });
    document.querySelectorAll(".q-card[data-id]").forEach((card) => {
      card.classList.toggle("is-picked", isPicked(card.dataset.id));
    });
    const single = $("#single-pick");
    const q = typeof currentQ === "function" ? currentQ() : null;
    if (single && q) single.checked = isPicked(q.id);
  }

  function saveProgress() {
    localStorage.setItem(PROGRESS_KEY, JSON.stringify(state.progress));
    updateStats();
  }

  function loadMode() {
    const m = localStorage.getItem(MODE_KEY);
    return m === "single" ? "single" : "list";
  }

  function saveMode() {
    localStorage.setItem(MODE_KEY, state.mode);
  }

  function updateStats() {
    if (!state.manifest) return;
    const vals = Object.values(state.progress);
    const done = vals.filter((p) => p.mastery === "mastered").length;
    const seen = vals.filter((p) => p.seen).length;
    const forgot = vals.filter((p) => p.mastery === "forgot").length;
    els.stats.textContent = `共 ${state.manifest.total} 题 · 看过 ${seen} · 掌握 ${done}`;
    if (els.metricTotal) els.metricTotal.textContent = String(state.manifest.total);
    if (els.metricSeen) els.metricSeen.textContent = String(seen);
    if (els.metricMastered) els.metricMastered.textContent = String(done);
    if (els.metricForgot) els.metricForgot.textContent = String(forgot);
    updateBrowseProgress();
  }

  function updateBrowseProgress() {
    if (!state.queue.length) {
      els.browseProgress.hidden = true;
      return;
    }
    let seen = 0;
    let mastered = 0;
    for (const q of state.queue) {
      const p = progressOf(q.id);
      if (p.seen || p.answered || p.mastery) seen += 1;
      if (p.mastery === "mastered") mastered += 1;
    }
    els.browseProgress.hidden = false;
    const pct = Math.round((seen / state.queue.length) * 100);
    els.progressFill.style.width = `${pct}%`;
    els.progressLabel.textContent = `看过 ${seen}/${state.queue.length} · 掌握 ${mastered}`;
  }

  function toast(msg) {
    els.toast.textContent = msg;
    els.toast.classList.remove("hidden");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => els.toast.classList.add("hidden"), 1800);
  }

  const fetchInflight = new Map();

  async function fetchJSON(path) {
    if (fetchInflight.has(path)) return fetchInflight.get(path);
    const job = (async () => {
      const res = await fetch(path, { cache: "force-cache" });
      if (!res.ok) throw new Error(`加载失败 ${path}: ${res.status}`);
      return res.json();
    })();
    fetchInflight.set(path, job);
    try {
      return await job;
    } finally {
      fetchInflight.delete(path);
    }
  }

  function prefetchUrl(href) {
    if (!href || document.querySelector(`link[rel="prefetch"][href="${href}"]`)) return;
    const link = document.createElement("link");
    link.rel = "prefetch";
    link.href = href;
    document.head.appendChild(link);
  }

  function assetUrl(src) {
    if (!src) return src;
    if (/^https?:\/\//i.test(src) || src.startsWith("data:")) return src;
    const m = String(src).match(/(?:^|\/)assets\/([0-9a-fA-F]{64})$/);
    if (m) {
      const base =
        (state.manifest && state.manifest.asset_base_remote) ||
        "https://cxyonly.fans/api/v1/question-assets/";
      return base + m[1];
    }
    if (src.startsWith("assets/")) {
      const base =
        (state.manifest && state.manifest.asset_base_remote) ||
        "https://cxyonly.fans/api/v1/question-assets/";
      return base + src.slice("assets/".length);
    }
    return src;
  }

  function renderMarkdown(text) {
    const raw = text || "";
    const slots = [];
    const protect = (s) => {
      s = s.replace(/\$\$([\s\S]+?)\$\$/g, (_, m) => {
        const i = slots.length;
        slots.push({ display: true, tex: m });
        return `%%MATH${i}%%`;
      });
      s = s.replace(/\\\[([\s\S]+?)\\\]/g, (_, m) => {
        const i = slots.length;
        slots.push({ display: true, tex: m });
        return `%%MATH${i}%%`;
      });
      s = s.replace(/\\\(([\s\S]+?)\\\)/g, (_, m) => {
        const i = slots.length;
        slots.push({ display: false, tex: m });
        return `%%MATH${i}%%`;
      });
      s = s.replace(/\$([^\$\n]+?)\$/g, (full, m, offset, whole) => {
        if (whole[offset - 1] === "$" || whole[offset + full.length] === "$") return full;
        const i = slots.length;
        slots.push({ display: false, tex: m });
        return `%%MATH${i}%%`;
      });
      return s;
    };

    let html;
    try {
      const src = protect(raw);
      html =
        typeof marked !== "undefined"
          ? marked.parse(src, { breaks: true })
          : src.replace(/</g, "&lt;").replace(/\n/g, "<br>");
      html = html.replace(/%%MATH(\d+)%%/g, (_, idx) => {
        const item = slots[Number(idx)];
        if (!item || typeof katex === "undefined") {
          return item ? (item.display ? `$$${item.tex}$$` : `$${item.tex}$`) : "";
        }
        try {
          return katex.renderToString(item.tex, {
            displayMode: item.display,
            throwOnError: false,
            strict: "ignore",
          });
        } catch {
          return item.display ? `$$${item.tex}$$` : `$${item.tex}$`;
        }
      });
    } catch {
      html = raw.replace(/</g, "&lt;").replace(/\n/g, "<br>");
    }

    const div = document.createElement("div");
    div.innerHTML = html;
    div.querySelectorAll("img").forEach((img) => {
      img.src = assetUrl(img.getAttribute("src") || "");
      img.loading = "lazy";
      img.decoding = "async";
      img.alt = img.alt || "题目配图";
    });
    return div.innerHTML;
  }

  function setView(name) {
    state.view = name;
    els.home.classList.toggle("hidden", name !== "home");
    els.browse.classList.toggle("hidden", name !== "browse");
    els.searchView.classList.toggle("hidden", name !== "search");
    document.querySelectorAll(".side-link").forEach((el) => {
      el.classList.toggle("active", el.dataset.nav === "home" && name === "home");
    });
    if (name === "home") {
      $("#nav-home")?.classList.add("active");
      $("#nav-todo")?.classList.remove("active");
      $("#nav-forgot")?.classList.remove("active");
    }
  }

  function applyModeUI() {
    const list = state.mode === "list";
    els.listMode.classList.toggle("hidden", !list);
    els.singleMode.classList.toggle("hidden", list);
    document.querySelectorAll(".mode-btn").forEach((b) => {
      b.classList.toggle("active", b.dataset.mode === state.mode);
    });
    document.body.dataset.mode = state.mode;
  }

  function setMode(mode) {
    if (mode !== "list" && mode !== "single") return;
    state.mode = mode;
    saveMode();
    applyModeUI();
    if (state.view === "browse" && state.queue.length) {
      if (mode === "list") renderFeed(true);
      else renderSingle();
    }
  }

  function findCat(id, nodes = state.categories, trail = []) {
    for (const n of nodes) {
      const t = trail.concat(n);
      if (String(n.id) === String(id)) return t;
      const hit = findCat(id, n.children || [], t);
      if (hit) return hit;
    }
    return null;
  }

  function progressOf(id) {
    return state.progress[String(id)] || {};
  }

  function cardState(id) {
    const key = String(id);
    if (!state.cardUI.has(key)) {
      state.cardUI.set(key, { showAnswer: false, selected: new Set() });
    }
    return state.cardUI.get(key);
  }

  function setMastery(id, mastery) {
    const key = String(id);
    const cur = state.progress[key] || {};
    state.progress[key] = { ...cur, mastery, seen: true, updated_at: Date.now() };
    saveProgress();
    refreshCardChrome(id);
    if (state.mode === "single") {
      renderMasteryChips();
      renderListStrip();
    }
  }

  function markSeen(id) {
    const key = String(id);
    const cur = state.progress[key] || {};
    if (!cur.seen) {
      state.progress[key] = { ...cur, seen: true, updated_at: Date.now() };
      saveProgress();
      refreshCardChrome(id);
    }
  }

  function markAnswered(id, ok) {
    const key = String(id);
    const cur = state.progress[key] || {};
    state.progress[key] = {
      ...cur,
      seen: true,
      answered: true,
      last_ok: !!ok,
      updated_at: Date.now(),
      mastery: cur.mastery || (ok ? "learning" : "forgot"),
    };
    saveProgress();
    refreshCardChrome(id);
  }

  function refreshCardChrome(id) {
    const card = els.qFeed?.querySelector(`.q-card[data-id="${id}"]`);
    if (!card) {
      updateBrowseProgress();
      return;
    }
    const p = progressOf(id);
    card.dataset.mastery = p.mastery || "not_started";
    if (p.seen) card.dataset.seen = "1";
    const badge = card.querySelector(".mastery-badge");
    if (badge) {
      const m = p.mastery || "not_started";
      badge.textContent = MASTERY_LABEL[m] || m;
      badge.dataset.mastery = m;
    }
    card.querySelectorAll(".chip[data-mastery]").forEach((el) => {
      el.classList.toggle("active", el.dataset.mastery === (p.mastery || "not_started"));
    });
    updateBrowseProgress();
  }

  const shardInflight = new Map();

  async function ensureShard(name) {
    if (state.shards.has(name)) return state.shards.get(name);
    if (shardInflight.has(name)) return shardInflight.get(name);
    const meta = state.manifest.shards[name];
    if (!meta) throw new Error("未知分片: " + name);
    const job = (async () => {
      const list = await fetchJSON(`${DATA}/${meta.file}`);
      const map = new Map(list.map((q) => [q.id, q]));
      state.shards.set(name, map);
      return map;
    })();
    shardInflight.set(name, job);
    try {
      return await job;
    } finally {
      shardInflight.delete(name);
    }
  }

  let indexesReady = null;

  function ensureIndexes() {
    if (state.idIndex && Object.keys(state.idIndex).length) return Promise.resolve();
    if (!indexesReady) {
      indexesReady = Promise.all([
        fetchJSON(`${DATA}/category_questions.json`),
        fetchJSON(`${DATA}/id_index.json`),
      ]).then(([catQuestions, idIndex]) => {
        state.catQuestions = catQuestions;
        state.idIndex = idIndex;
      });
    }
    return indexesReady;
  }

  function prefetchCategory(catId) {
    ensureIndexes().then(() => {
      const ids = state.catQuestions[String(catId)] || [];
      const names = new Set();
      for (const id of ids) {
        const n = state.idIndex[String(id)];
        if (n) names.add(n);
      }
      for (const name of names) {
        const meta = state.manifest && state.manifest.shards[name];
        if (meta) prefetchUrl(`${DATA}/${meta.file}`);
      }
    }).catch(() => {});
  }

  function questionMarkdown(q) {
    const parts = [];
    if (q.stem) parts.push(String(q.stem).trim());
    const opts = q.options || [];
    if (opts.length) {
      parts.push(
        opts
          .map((opt, i) => {
            const lab = opt.label || String.fromCharCode(65 + i);
            return `${lab}. ${opt.content_md || ""}`.trimEnd();
          })
          .join("\n")
      );
    }
    if (q.answer) parts.push(`答案\n${String(q.answer).trim()}`);
    if (q.explanation) parts.push(`解析\n${String(q.explanation).trim()}`);
    return parts.filter(Boolean).join("\n\n") + "\n";
  }

  async function copyQuestionMarkdown(q) {
    if (!q) return;
    const ok = await copyText(questionMarkdown(q));
    toast(ok ? "已复制 Markdown" : "复制失败");
  }

  async function getQuestion(id) {
    const name = state.idIndex[String(id)];
    if (!name) return null;
    const map = await ensureShard(name);
    return map.get(Number(id)) || map.get(id) || null;
  }

  async function loadQueueQuestions(ids) {
    const byShard = new Map();
    for (const id of ids) {
      const name = state.idIndex[String(id)];
      if (!name) continue;
      if (!byShard.has(name)) byShard.set(name, []);
      byShard.get(name).push(id);
    }
    await Promise.all([...byShard.keys()].map((n) => ensureShard(n)));
    const out = [];
    for (const id of ids) {
      const q = await getQuestion(id);
      if (q) out.push(q);
    }
    return out;
  }

  function filterQuestions(qs) {
    return qs.filter((q) => {
      if ((state.filterCore || state.scope === "core") && !q.is_core) return false;
      if (state.filterTodo) {
        const p = progressOf(q.id);
        if (p.mastery === "mastered") return false;
      }
      return true;
    });
  }

  function renderTree(nodes = state.categories, depth = 0) {
    const frag = document.createDocumentFragment();
    for (const n of nodes) {
      const wrap = document.createElement("div");
      wrap.className = "cat-node";
      wrap.dataset.id = n.id;

      const hasKids = (n.children || []).length > 0;
      const row = document.createElement("div");
      row.className = "cat-line";

      const twisty = document.createElement("button");
      twisty.type = "button";
      twisty.className = "cat-twisty";
      twisty.textContent = hasKids ? (depth < 1 ? "▾" : "▸") : "";
      twisty.disabled = !hasKids;
      twisty.setAttribute("aria-label", "展开/折叠");

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "cat-row";
      btn.dataset.catId = n.id;
      if (String(state.currentCatId) === String(n.id)) btn.classList.add("active");
      btn.innerHTML = `<span class="cat-name">${escapeHtml(n.name)}</span><span class="cat-count">${n.question_count || 0}</span>`;

      const kids = document.createElement("div");
      kids.className = "cat-children" + (depth < 1 ? "" : " collapsed");
      if (hasKids) kids.appendChild(renderTree(n.children, depth + 1));

      twisty.addEventListener("click", (e) => {
        e.stopPropagation();
        if (!hasKids) return;
        const collapsed = kids.classList.toggle("collapsed");
        twisty.textContent = collapsed ? "▸" : "▾";
      });
      btn.addEventListener("pointerenter", () => prefetchCategory(n.id), { once: true });
      btn.addEventListener("click", () => openCategory(n.id));

      row.append(twisty, btn);
      wrap.append(row, kids);
      frag.appendChild(wrap);
    }
    return frag;
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function paintTree() {
    els.catTree.innerHTML = "";
    els.catTree.appendChild(renderTree(state.categories, 0));
  }

  function renderHome() {
    els.homeCards.innerHTML = "";
    for (const n of state.categories) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "home-card";
      const done = countMasteredInCat(n.id);
      const total = n.question_count || 0;
      const pct = total ? Math.round((done / total) * 100) : 0;
      b.innerHTML = `
        <div class="home-card-top">
          <strong>${escapeHtml(n.name)}</strong>
          <span class="home-card-count">${total} 题</span>
        </div>
        <div class="home-card-bar"><i style="width:${pct}%"></i></div>
        <span class="home-card-meta">${done ? `已掌握 ${done}` : "尚未开始"}</span>`;
      b.addEventListener("pointerenter", () => prefetchCategory(n.id), { once: true });
      b.addEventListener("click", () => openCategory(n.id));
      els.homeCards.appendChild(b);
    }
    updateStats();
  }

  function countMasteredInCat(catId) {
    const ids = state.catQuestions[String(catId)] || [];
    let n = 0;
    for (const id of ids) {
      if (progressOf(id).mastery === "mastered") n += 1;
    }
    return n;
  }

  async function openCategory(catId, startId = null) {
    await ensureIndexes();
    state.specialQueue = null;
    state.currentCatId = catId;
    const trail = findCat(catId) || [];
    state.crumb = trail.map((x) => x.name).join(" / ") || "练习";
    els.crumb.textContent = state.crumb;
    paintTree();
    setNavActive(null);

    const ids = state.catQuestions[String(catId)] || [];
    if (!ids.length) {
      toast("该分类暂无题目");
      return;
    }

    els.crumb.textContent = state.crumb + " · 加载中…";
    let qs = await loadQueueQuestions(ids);
    qs = filterQuestions(qs);
    if (!qs.length) {
      toast("筛选后没有题目");
      els.crumb.textContent = state.crumb;
      return;
    }

    beginBrowse(qs, state.crumb, startId);
  }

  async function openSpecial(kind) {
    await ensureIndexes();
    state.specialQueue = kind;
    state.currentCatId = null;
    paintTree();
    setNavActive(kind);

    const ids = Object.keys(state.progress).filter((id) => {
      const p = state.progress[id];
      if (kind === "todo") return p.mastery && p.mastery !== "mastered";
      if (kind === "forgot") return p.mastery === "forgot";
      return false;
    });

    // also include seen-but-not-mastered for todo if none marked
    if (kind === "todo" && !ids.length) {
      for (const [id, p] of Object.entries(state.progress)) {
        if (p.seen && p.mastery !== "mastered") ids.push(id);
      }
    }

    const title = kind === "forgot" ? "易错题" : "未掌握";
    state.crumb = title;
    els.crumb.textContent = title + " · 加载中…";

    if (!ids.length) {
      toast(kind === "forgot" ? "还没有标记易错的题" : "还没有未掌握的题");
      els.crumb.textContent = title;
      setView("home");
      return;
    }

    let qs = await loadQueueQuestions(ids);
    qs = filterQuestions(qs);
    if (!qs.length) {
      toast("筛选后没有题目");
      setView("home");
      return;
    }
    beginBrowse(qs, title, null);
  }

  function setNavActive(kind) {
    document.querySelectorAll(".side-link").forEach((el) => {
      const nav = el.dataset.nav;
      el.classList.toggle(
        "active",
        (kind === null && nav === "home" && state.view === "home") ||
          (kind && nav === kind)
      );
    });
  }

  function beginBrowse(qs, title, startId) {
    state.queue = qs;
    state.index = 0;
    state.cardUI = new Map();
    state.renderedCount = 0;
    state.showAnswer = false;
    state.selected = new Set();

    if (startId != null) {
      const i = qs.findIndex((q) => Number(q.id) === Number(startId));
      if (i >= 0) state.index = i;
    }

    setView("browse");
    applyModeUI();
    els.crumb.textContent = `${title} · ${qs.length} 题`;
    els.browseHeading.textContent = title;
    els.browseSub.textContent = `共 ${qs.length} 题` + (state.mode === "list" ? " · 列表连续浏览" : " · 单题专注");
    updateBrowseProgress();

    if (state.mode === "list") {
      // if jumping to a specific id, ensure it's in the first batch window
      if (startId != null && state.index > 0) {
        state.renderedCount = 0;
        renderFeed(true);
        // expand pages until target is rendered
        while (state.renderedCount <= state.index && state.renderedCount < state.queue.length) {
          appendFeedPage();
        }
        requestAnimationFrame(() => {
          const el = els.qFeed.querySelector(`.q-card[data-id="${startId}"]`);
          if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
        });
      } else {
        renderFeed(true);
      }
    } else {
      renderSingle();
    }

    if (window.innerWidth <= 900) els.sidebar.classList.remove("open");
    window.scrollTo({ top: 0, behavior: "instant" in window ? "instant" : "auto" });
  }

  function currentQ() {
    return state.queue[state.index] || null;
  }

  /* ---------- LIST MODE ---------- */

  function renderFeed(reset) {
    if (reset) {
      els.qFeed.innerHTML = "";
      state.renderedCount = 0;
      feedLoading = false;
    }
    ensureFeedSentinel();
    appendFeedPage();
    refreshPickUI();
  }

  let feedLoading = false;
  let feedSentinelObs = null;

  function ensureFeedSentinel() {
    let tip = document.getElementById("feed-sentinel");
    if (!tip) {
      tip = document.createElement("div");
      tip.id = "feed-sentinel";
      tip.className = "feed-sentinel";
      tip.setAttribute("aria-hidden", "true");
      els.feedFoot.before(tip);
    }
    if (!feedSentinelObs && "IntersectionObserver" in window) {
      feedSentinelObs = new IntersectionObserver(
        (entries) => {
          if (!entries.some((e) => e.isIntersecting)) return;
          if (state.view !== "browse" || state.mode !== "list") return;
          if (els.loadMore.disabled || feedLoading) return;
          appendFeedPage();
        },
        { root: null, rootMargin: "240px 0px", threshold: 0 }
      );
      feedSentinelObs.observe(tip);
    }
    return tip;
  }

  function appendFeedPage() {
    if (feedLoading) return false;
    const start = state.renderedCount;
    const end = Math.min(state.queue.length, start + PAGE_SIZE);
    if (start >= end) {
      if (start > 0) {
        els.feedStatus.textContent = "已全部加载";
        els.loadMore.disabled = true;
      }
      return false;
    }

    feedLoading = true;
    const frag = document.createDocumentFragment();
    for (let i = start; i < end; i++) {
      frag.appendChild(buildCard(state.queue[i], i));
    }
    els.qFeed.appendChild(frag);
    state.renderedCount = end;

    const remain = state.queue.length - end;
    els.loadMore.disabled = remain <= 0;
    els.feedStatus.textContent =
      remain > 0
        ? `已显示 ${end} / ${state.queue.length} · 还有 ${remain} 题`
        : `共 ${state.queue.length} 题 · 已全部显示`;

    observeCards();
    ensureFeedSentinel();

    // unlock after paint; next page only when sentinel intersects again
    requestAnimationFrame(() => {
      setTimeout(() => {
        feedLoading = false;
      }, 280);
    });
    return true;
  }

  let cardObserver = null;
  function observeCards() {
    if (!("IntersectionObserver" in window)) {
      // fallback: mark all rendered
      els.qFeed.querySelectorAll(".q-card").forEach((c) => markSeen(c.dataset.id));
      return;
    }
    if (!cardObserver) {
      cardObserver = new IntersectionObserver(
        (entries) => {
          for (const e of entries) {
            if (e.isIntersecting) {
              markSeen(e.target.dataset.id);
              cardObserver.unobserve(e.target);
            }
          }
        },
        { root: null, rootMargin: "80px", threshold: 0.2 }
      );
    }
    els.qFeed.querySelectorAll(".q-card:not([data-observed])").forEach((c) => {
      c.dataset.observed = "1";
      cardObserver.observe(c);
    });
  }

  function buildCard(q, index) {
    const ui = cardState(q.id);
    const p = progressOf(q.id);
    const mastery = p.mastery || "not_started";
    const li = document.createElement("li");
    li.className = "q-card";
    li.dataset.id = q.id;
    li.dataset.mastery = mastery;
    if (p.seen) li.dataset.seen = "1";
    li.id = `q-${q.id}`;

    const picked = isPicked(q.id);
    if (picked) li.classList.add("is-picked");

    const head = document.createElement("div");
    head.className = "q-card-head";
    head.innerHTML = `
      <div class="q-card-index">
        <label class="pick-check" title="勾选导出">
          <input type="checkbox" data-pick-id="${q.id}" ${picked ? "checked" : ""} />
        </label>
        <span class="q-num">${index + 1}</span>
        <span class="mastery-badge" data-mastery="${mastery}">${MASTERY_LABEL[mastery]}</span>
      </div>
      <div class="q-card-tags">
        ${q.is_core ? `<span class="pill core">核心</span>` : ""}
        <span class="pill">${escapeHtml(q.source || "未知来源")}</span>
        <span class="pill soft">${escapeHtml(TYPE_LABEL[q.type] || q.type || "题目")}</span>
        <span class="pill soft">#${q.id}</span>
      </div>`;
    head.querySelector("[data-pick-id]").addEventListener("change", (e) => {
      setPicked(q.id, e.target.checked);
    });

    const path = document.createElement("div");
    path.className = "q-path";
    path.textContent = q.category_path || "";

    const stem = document.createElement("div");
    stem.className = "md q-stem";
    stem.innerHTML = renderMarkdown(q.stem);

    const options = document.createElement("div");
    options.className = "options";
    renderOptionsInto(options, q, ui);

    const actions = document.createElement("div");
    actions.className = "q-actions";
    const ansBtn = document.createElement("button");
    ansBtn.type = "button";
    ansBtn.className = "btn primary";
    ansBtn.textContent = ui.showAnswer ? "隐藏答案" : "显示答案";
    ansBtn.addEventListener("click", () => {
      ui.showAnswer = !ui.showAnswer;
      if (ui.showAnswer) {
        const ok = gradeChoice(q, ui.selected);
        if (ok != null) markAnswered(q.id, ok);
        else markSeen(q.id);
      }
      // re-render this card body parts
      rebuildCardBody(li, q, index);
    });

    const focusBtn = document.createElement("button");
    focusBtn.type = "button";
    focusBtn.className = "btn ghost";
    focusBtn.textContent = "单题";
    focusBtn.title = "在单题模式中打开";
    focusBtn.addEventListener("click", () => {
      state.index = index;
      setMode("single");
    });

    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "btn ghost";
    copyBtn.textContent = "复制 Markdown";
    copyBtn.title = "复制本题源 Markdown";
    copyBtn.addEventListener("click", () => copyQuestionMarkdown(q));

    actions.append(ansBtn, focusBtn, copyBtn);

    const masteryRow = document.createElement("div");
    masteryRow.className = "mastery-row";
    masteryRow.innerHTML = `<span class="muted">掌握</span>`;
    for (const [key, label] of Object.entries(MASTERY_LABEL)) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "chip" + (key === "forgot" ? " danger" : "");
      chip.dataset.mastery = key;
      chip.textContent = label;
      if (key === mastery) chip.classList.add("active");
      chip.addEventListener("click", () => setMastery(q.id, key));
      masteryRow.appendChild(chip);
    }

    const answerBox = document.createElement("div");
    answerBox.className = "answer-box" + (ui.showAnswer ? "" : " hidden");
    if (ui.showAnswer) {
      answerBox.innerHTML = `
        <div class="answer-block">
          <h3>答案</h3>
          <div class="md">${renderMarkdown(q.answer || "（无答案）")}</div>
        </div>
        <div class="answer-block">
          <h3>解析</h3>
          <div class="md">${renderMarkdown(q.explanation || "（无解析）")}</div>
        </div>`;
    }

    li.append(head, path, stem, options, actions, masteryRow, answerBox);
    return li;
  }

  function rebuildCardBody(li, q, index) {
    const next = buildCard(q, index);
    li.replaceWith(next);
    next.dataset.observed = "1";
    // keep in view roughly
  }

  function renderOptionsInto(container, q, ui) {
    container.innerHTML = "";
    const opts = q.options || [];
    const multi = q.type === "multiple_choice";
    opts.forEach((opt, i) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "opt";
      const lab = opt.label || String.fromCharCode(65 + i);
      const L = lab.toUpperCase();
      b.innerHTML = `<span class="opt-lab">${escapeHtml(lab)}</span><div class="md">${renderMarkdown(opt.content_md || "")}</div>`;
      if (ui.selected.has(L)) b.classList.add("selected");
      if (ui.showAnswer && q.correct_labels && q.correct_labels.length) {
        if (q.correct_labels.map((x) => String(x).toUpperCase()).includes(L)) b.classList.add("correct");
        else if (ui.selected.has(L)) b.classList.add("wrong");
      }
      b.addEventListener("click", () => {
        if (multi) {
          if (ui.selected.has(L)) ui.selected.delete(L);
          else ui.selected.add(L);
        } else {
          ui.selected = new Set([L]);
        }
        // update selection styles without full rebuild when answer hidden
        if (!ui.showAnswer) {
          container.querySelectorAll(".opt").forEach((el) => el.classList.remove("selected"));
          if (multi) {
            // rebuild simple
            renderOptionsInto(container, q, ui);
          } else {
            b.classList.add("selected");
            const ok = gradeChoice(q, ui.selected);
            if (ok != null) markAnswered(q.id, ok);
          }
        } else {
          const card = container.closest(".q-card");
          const idx = state.queue.findIndex((x) => Number(x.id) === Number(q.id));
          if (card) rebuildCardBody(card, q, idx >= 0 ? idx : 0);
        }
      });
      container.appendChild(b);
    });
  }

  /* ---------- SINGLE MODE ---------- */

  function renderSingle() {
    const q = currentQ();
    if (!q) return;
    markSeen(q.id);

    els.qPos.textContent = `${state.index + 1} / ${state.queue.length}`;
    els.qSource.textContent = q.source || "未知来源";
    els.qType.textContent = TYPE_LABEL[q.type] || q.type || "题目";
    els.qId.textContent = `#${q.id}`;
    els.qPath.textContent = q.category_path || "";
    els.qStem.innerHTML = renderMarkdown(q.stem);

    els.qOptions.innerHTML = "";
    const opts = q.options || [];
    const multi = q.type === "multiple_choice";
    opts.forEach((opt, i) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "opt";
      const lab = opt.label || String.fromCharCode(65 + i);
      b.innerHTML = `<span class="opt-lab">${escapeHtml(lab)}</span><div class="md">${renderMarkdown(opt.content_md || "")}</div>`;
      if (state.selected.has(lab.toUpperCase())) b.classList.add("selected");
      b.addEventListener("click", () => {
        const L = lab.toUpperCase();
        if (multi) {
          if (state.selected.has(L)) state.selected.delete(L);
          else state.selected.add(L);
        } else {
          state.selected = new Set([L]);
        }
        renderSingle();
        if (!multi && state.selected.size) {
          const ok = gradeChoice(q, state.selected);
          if (ok != null) markAnswered(q.id, ok);
        }
      });
      if (state.showAnswer && q.correct_labels && q.correct_labels.length) {
        const L = lab.toUpperCase();
        if (q.correct_labels.map((x) => String(x).toUpperCase()).includes(L)) b.classList.add("correct");
        else if (state.selected.has(L)) b.classList.add("wrong");
      }
      els.qOptions.appendChild(b);
    });

    els.answerBox.classList.toggle("hidden", !state.showAnswer);
    if (state.showAnswer) {
      els.qAnswer.innerHTML = renderMarkdown(q.answer || "（无答案）");
      els.qExpl.innerHTML = renderMarkdown(q.explanation || "（无解析）");
      $("#btn-toggle-answer").textContent = "隐藏答案";
    } else {
      $("#btn-toggle-answer").textContent = "显示答案";
    }

    $("#btn-prev").disabled = state.index <= 0;
    $("#btn-next").disabled = state.index >= state.queue.length - 1;
    const singlePick = $("#single-pick");
    if (singlePick) singlePick.checked = isPicked(q.id);
    renderMasteryChips();
    renderListStrip();
    updateBrowseProgress();
  }

  function gradeChoice(q, selectedSet) {
    const labels = (q.correct_labels || []).map((x) => String(x).toUpperCase());
    if (!labels.length || !selectedSet.size) return null;
    const sel = [...selectedSet].sort().join(",");
    const ans = [...labels].sort().join(",");
    return sel === ans;
  }

  function renderMasteryChips() {
    const q = currentQ();
    if (!q) return;
    const cur = progressOf(q.id).mastery || "not_started";
    document.querySelectorAll("#single-mastery .chip[data-mastery]").forEach((el) => {
      el.classList.toggle("active", el.dataset.mastery === cur);
    });
  }

  function renderListStrip() {
    const max = 80;
    const start = Math.max(0, Math.min(state.index - 20, state.queue.length - max));
    const end = Math.min(state.queue.length, start + max);
    els.listStrip.innerHTML = "";
    for (let i = start; i < end; i++) {
      const q = state.queue[i];
      const p = progressOf(q.id);
      const b = document.createElement("button");
      b.type = "button";
      b.className = "dot";
      b.textContent = String(i + 1);
      if (i === state.index) b.classList.add("current");
      if (p.mastery === "mastered") b.classList.add("mastered");
      else if (p.mastery === "forgot" || p.last_ok === false) b.classList.add("bad");
      else if (p.seen || p.answered) b.classList.add("done");
      b.addEventListener("click", () => {
        state.index = i;
        state.showAnswer = false;
        state.selected = new Set();
        renderSingle();
      });
      els.listStrip.appendChild(b);
    }
  }

  function go(delta) {
    const next = state.index + delta;
    if (next < 0 || next >= state.queue.length) return;
    state.index = next;
    state.showAnswer = false;
    state.selected = new Set();
    renderSingle();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function shuffleQueue() {
    if (state.queue.length < 2) {
      toast("当前没有可打乱的题目");
      return;
    }
    const curId = currentQ()?.id;
    for (let i = state.queue.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [state.queue[i], state.queue[j]] = [state.queue[j], state.queue[i]];
    }
    if (curId != null) {
      const i = state.queue.findIndex((q) => q.id === curId);
      state.index = i >= 0 ? i : 0;
    } else state.index = 0;
    state.showAnswer = false;
    state.selected = new Set();
    state.cardUI = new Map();
    if (state.mode === "list") renderFeed(true);
    else renderSingle();
    toast("已打乱顺序");
  }

  function expandAllAnswers() {
    if (state.mode !== "list") {
      state.showAnswer = true;
      renderSingle();
      return;
    }
    const cards = els.qFeed.querySelectorAll(".q-card");
    cards.forEach((card) => {
      const id = card.dataset.id;
      const ui = cardState(id);
      ui.showAnswer = true;
      const q = state.queue.find((x) => String(x.id) === String(id));
      if (!q) return;
      const idx = state.queue.indexOf(q);
      rebuildCardBody(card, q, idx);
    });
    toast("已展开当前页答案");
  }

  async function ensureSearchIndex() {
    if (state.searchIndex) return state.searchIndex;
    state.searchIndex = await fetchJSON(`${DATA}/search_index.json`);
    return state.searchIndex;
  }

  async function runSearch(q) {
    const query = q.trim();
    if (!query) {
      setView(state.queue.length ? "browse" : "home");
      return;
    }
    const idx = await ensureSearchIndex();
    const ql = query.toLowerCase();
    const asNum = /^\d+$/.test(query) ? Number(query) : null;
    const hits = [];
    for (const item of idx) {
      if (asNum != null && Number(item.id) === asNum) {
        hits.unshift(item);
        continue;
      }
      const blob = `${item.id} ${item.source || ""} ${item.path || ""} ${item.stem || ""}`.toLowerCase();
      if (blob.includes(ql)) hits.push(item);
      if (hits.length >= 80) break;
    }
    setView("search");
    els.searchCount.textContent = `(${hits.length})`;
    els.searchResults.innerHTML = "";
    if (!hits.length) {
      els.searchResults.innerHTML = `<p class="muted">没有匹配结果</p>`;
      return;
    }
    for (const h of hits) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "search-item";
      b.innerHTML = `
        <label class="pick-check" title="勾选导出">
          <input type="checkbox" data-pick-id="${h.id}" ${isPicked(h.id) ? "checked" : ""} />
        </label>
        <div class="s-top">
          <span>#${h.id}</span>
          <span>${escapeHtml(h.source || "")}</span>
          <span>${escapeHtml(TYPE_LABEL[h.type] || h.type || "")}</span>
          <span>${escapeHtml(h.path || "")}</span>
        </div>
        <div class="s-stem">${escapeHtml(stripMd(h.stem || ""))}</div>`;
      b.querySelector(".pick-check").addEventListener("click", (e) => e.stopPropagation());
      b.querySelector("[data-pick-id]").addEventListener("change", (e) => {
        setPicked(h.id, e.target.checked);
      });
      b.addEventListener("click", async () => {
        const top = (h.path || "未分类").split(" / ")[0];
        const cat = state.categories.find((c) => c.name === top) || state.categories[0];
        const catId = findCatIdByPath(h.path) || (cat && cat.id);
        await openCategory(catId, h.id);
      });
      els.searchResults.appendChild(b);
    }
  }

  function stripMd(s) {
    return String(s)
      .replace(/\$\$[\s\S]+?\$\$/g, " ")
      .replace(/\$[^$]+\$/g, " ")
      .replace(/[#>*_`\[\]()]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function findCatIdByPath(path) {
    if (!path) return null;
    const parts = path.split(" / ").map((x) => x.trim()).filter(Boolean);
    let nodes = state.categories;
    let last = null;
    for (const part of parts) {
      const hit = nodes.find((n) => n.name === part);
      if (!hit) break;
      last = hit;
      nodes = hit.children || [];
    }
    return last ? last.id : null;
  }

  function goHome() {
    setView("home");
    state.currentCatId = null;
    state.specialQueue = null;
    els.crumb.textContent = "选择左侧分类开始";
    paintTree();
    setNavActive(null);
    $("#nav-home")?.classList.add("active");
    renderHome();
  }

  const EXPORT_SOFT_LIMIT = 80;
  const EXPORT_HARD_LIMIT = 250;

  function formatDate(d = new Date()) {
    return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
  }

  function isoDate(d = new Date()) {
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${d.getFullYear()}-${m}-${day}`;
  }

  function safeFilename(s) {
    return String(s || "题目")
      .replace(/[\\/:*?"<>|]+/g, "-")
      .replace(/\s+/g, "")
      .slice(0, 40) || "题目";
  }

  function progressBuckets() {
    const mastered = [];
    const forgot = [];
    const learning = [];
    for (const [id, p] of Object.entries(state.progress)) {
      if (p.mastery === "mastered") mastered.push(id);
      else if (p.mastery === "forgot") forgot.push(id);
      else if (p.mastery === "learning") learning.push(id);
    }
    return { mastered, forgot, learning };
  }

  function buildProgressPayload() {
    const map = {};
    for (const [id, p] of Object.entries(state.progress)) {
      if (p.mastery === "mastered") map[id] = "m";
      else if (p.mastery === "forgot") map[id] = "f";
      else if (p.mastery === "learning") map[id] = "l";
    }
    return {
      v: 1,
      src: "daguan-math",
      at: Date.now(),
      map,
    };
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    }
  }

  function downloadText(filename, text, mime) {
    const blob = new Blob([text], { type: mime || "text/plain;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1500);
  }

  function closeSheet(id) {
    const el = document.getElementById(id);
    if (el && typeof el.close === "function") el.close();
  }

  function openSheet(id) {
    const el = document.getElementById(id);
    if (el && typeof el.showModal === "function") el.showModal();
  }

  function exportScopeLabel(scope) {
    if (scope === "picked") return "已勾选";
    if (scope === "todo") return "未掌握";
    if (scope === "forgot") return "易错题";
    if (scope === "mastered") return "已掌握";
    return state.crumb || "当前列表";
  }

  async function collectExportQuestions(scope) {
    await ensureIndexes();
    if (scope === "queue") return state.queue.slice();
    if (scope === "picked") {
      const ids = pickedIdsOrdered();
      if (!ids.length) return [];
      return loadQueueQuestions(ids);
    }
    const b = progressBuckets();
    let ids = [];
    if (scope === "todo") ids = [...b.forgot, ...b.learning];
    else if (scope === "forgot") ids = b.forgot;
    else if (scope === "mastered") ids = b.mastered;
    if (!ids.length) return [];
    return loadQueueQuestions(ids);
  }

  function renderPrintOptions(q) {
    const opts = q.options || [];
    if (!opts.length) return "";
    const rows = opts
      .map((opt, i) => {
        const lab = opt.label || String.fromCharCode(65 + i);
        return `<div class="print-opt"><span class="lab">${escapeHtml(lab)}.</span><div class="md">${renderMarkdown(opt.content_md || "")}</div></div>`;
      })
      .join("");
    return `<div class="print-opts">${rows}</div>`;
  }

  function buildPrintDoc(qs, { title, withAnswers, withExpl }) {
    const date = formatDate();
    const fname = `大观园-${safeFilename(title)}-${isoDate()}.pdf`;
    const extra = [withAnswers ? "含答案" : "", withExpl ? "含解析" : ""].filter(Boolean).join(" · ");
    const mast = `
      <header class="print-mast">
        <strong>${escapeHtml(title)}</strong>
        <span>${qs.length} 题${extra ? " · " + extra : ""} · ${escapeHtml(date)}</span>
      </header>`;
    const items = qs
      .map((q, i) => {
        const bits = [TYPE_LABEL[q.type] || q.type, q.source, `#${q.id}`].filter(Boolean);
        const meta = `${i + 1}. ${bits.join(" · ")}`;
        let key = "";
        if (withAnswers) {
          key = `<div class="print-key"><div class="print-key-row"><span class="print-lab">答</span><div class="md">${renderMarkdown(q.answer || "（无）")}</div></div>`;
          if (withExpl) {
            key += `<div class="print-key-row"><span class="print-lab">析</span><div class="md">${renderMarkdown(q.explanation || "（无）")}</div></div>`;
          }
          key += `</div>`;
        }
        return `<article class="print-q">
          <p class="print-q-meta">${escapeHtml(meta)}</p>
          <div class="md stem">${renderMarkdown(q.stem)}</div>
          ${renderPrintOptions(q)}
          ${key}
        </article>`;
      })
      .join("");
    return { html: mast + items, filename: fname };
  }

  async function waitPrintAssets(root) {
    const imgs = [...root.querySelectorAll("img")];
    await Promise.all(
      imgs.map((img) => {
        if (img.complete && img.naturalWidth) return Promise.resolve();
        return img.decode ? img.decode().catch(() => {}) : new Promise((res) => {
          img.addEventListener("load", res, { once: true });
          img.addEventListener("error", res, { once: true });
        });
      })
    );
    if (document.fonts && document.fonts.ready) {
      try {
        await document.fonts.ready;
      } catch {
        /* ignore */
      }
    }
  }

  function closePrintPreview() {
    document.body.classList.remove("print-preview");
    const stage = $("#print-stage");
    stage.hidden = true;
    stage.classList.add("hidden");
    $("#print-doc").innerHTML = "";
  }

  async function openPrintPreview(qs, opts) {
    const { html, filename } = buildPrintDoc(qs, opts);
    const stage = $("#print-stage");
    const doc = $("#print-doc");
    doc.innerHTML = html;
    $("#print-meta").textContent = `${qs.length} 题 · ${opts.title} · ${filename}`;
    stage.hidden = false;
    stage.classList.remove("hidden");
    document.body.classList.add("print-preview");
    window.scrollTo(0, 0);
    await waitPrintAssets(doc);
  }

  function refreshExportCounts() {
    const b = progressBuckets();
    const set = (id, n) => {
      const el = document.getElementById(id);
      if (el) el.textContent = n ? `（${n}）` : "";
    };
    set("export-count-picked", state.picked.size);
    set("export-count-queue", state.queue.length);
    set("export-count-todo", b.forgot.length + b.learning.length);
    set("export-count-forgot", b.forgot.length);
    set("export-count-mastered", b.mastered.length);
    const pickedRadio = document.querySelector('input[name="export-scope"][value="picked"]');
    const queueRadio = document.querySelector('input[name="export-scope"][value="queue"]');
    if (pickedRadio) pickedRadio.disabled = !state.picked.size;
    if (queueRadio) queueRadio.disabled = !state.queue.length;
    if (state.picked.size && pickedRadio) pickedRadio.checked = true;
    else if (state.queue.length && queueRadio) queueRadio.checked = true;
    else if (!state.queue.length && !state.picked.size) {
      const mastered = document.querySelector('input[name="export-scope"][value="mastered"]');
      const todo = document.querySelector('input[name="export-scope"][value="todo"]');
      if (mastered && b.mastered.length) mastered.checked = true;
      else if (todo && (b.forgot.length || b.learning.length)) todo.checked = true;
    }
  }

  async function runExportPreview() {
    const scope =
      document.querySelector('input[name="export-scope"]:checked')?.value || "queue";
    const withAnswers = $("#export-answers").checked;
    const withExpl = $("#export-expl").checked && withAnswers;
    const btn = $("#btn-export-go");
    btn.disabled = true;
    btn.textContent = "正在整理题目…";
    try {
      const qs = await collectExportQuestions(scope);
      if (!qs.length) {
        toast(
          scope === "picked"
            ? "还没有勾选题目，点卡片左侧方框即可"
            : scope === "queue"
              ? "当前没有可导出的列表，先打开一个分类"
              : "这个范围里没有题目"
        );
        return;
      }
      if (qs.length > EXPORT_HARD_LIMIT) {
        toast(`一次最多 ${EXPORT_HARD_LIMIT} 题，请换更小的分类或筛选后再导出`);
        return;
      }
      if (qs.length > EXPORT_SOFT_LIMIT) {
        const ok = confirm(
          `将导出 ${qs.length} 题。题目较多时预览和打印会比较慢，建议按章节分批。仍然继续？`
        );
        if (!ok) return;
      }
      closeSheet("dlg-export");
      await openPrintPreview(qs, {
        title: exportScopeLabel(scope),
        withAnswers,
        withExpl,
      });
    } catch (err) {
      console.error(err);
      toast("导出失败：" + (err.message || String(err)));
    } finally {
      btn.disabled = false;
      btn.textContent = "生成预览";
    }
  }

  function refreshSyncStats() {
    const b = progressBuckets();
    $("#sync-n-mastered").textContent = String(b.mastered.length);
    $("#sync-n-forgot").textContent = String(b.forgot.length);
    $("#sync-n-learning").textContent = String(b.learning.length);
    const empty = !b.mastered.length && !b.forgot.length && !b.learning.length;
    const hint = $("#sync-empty-hint");
    if (hint) hint.hidden = !empty;
    const copyBtn = $("#btn-copy-script");
    const dlBtn = $("#btn-download-progress");
    if (copyBtn) copyBtn.disabled = empty;
    if (dlBtn) dlBtn.disabled = empty;
  }

  function officialSyncScript() {
    const payload = buildProgressPayload();
    return `(() => {
  const payload = ${JSON.stringify(payload)};
  if (!payload || !payload.map) {
    console.error("进度数据为空。");
    return;
  }
  const token = localStorage.getItem("daguan_token") || localStorage.getItem("token");
  if (!token) {
    console.error("未登录：在大观园页面找不到登录令牌。请先登录再运行。");
    return;
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const hdr = () => {
    const h = {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: "Bearer " + token,
    };
    const csrf = localStorage.getItem("csrf_token");
    if (csrf) h["X-CSRF-Token"] = csrf;
    return h;
  };
  async function api(path, opt) {
    const res = await fetch("/api" + path, Object.assign({ credentials: "same-origin", headers: hdr() }, opt || {}));
    let data = null;
    try { data = await res.json(); } catch (e) {}
    return { res: res, data: data };
  }
  const localToRemote = { m: "mastered", f: "needs_practice", l: "needs_practice" };
  const items = Object.keys(payload.map).map((id) => ({
    id: id,
    remote: localToRemote[payload.map[id]],
  })).filter((x) => x.remote);
  console.log("将预览写入 " + items.length + " 题（已掌握→掌握，易错/学习中→不熟练）。未开始的题不会提交。");
  const word = prompt("确认写入 " + items.length + " 题到当前登录账号？输入 SYNC 开始，取消则退出");
  if (word !== "SYNC") {
    console.log("已取消");
    return;
  }
  (async () => {
    const csrfRes = await api("/auth/csrf");
    const csrfToken = csrfRes.data && (csrfRes.data.csrf_token || csrfRes.data.token || (csrfRes.data.data && csrfRes.data.data.csrf_token));
    if (csrfToken) localStorage.setItem("csrf_token", csrfToken);
    const me = await api("/auth/me");
    if (!me.res.ok) {
      console.error("登录无效，请刷新大观园后重新登录。", me.res.status, me.data);
      return;
    }
    const bodies = {
      mastered: [{ mastery: "mastered" }, { mastered: true }],
      needs_practice: [{ mastery: "needs_practice" }, { needs_practice: true }],
    };
    let shapeKey = null;
    let ok = 0, fail = 0;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const list = shapeKey ? [shapeKey] : bodies[it.remote];
      let done = false;
      for (let j = 0; j < list.length; j++) {
        const body = list[j];
        const out = await api("/questions/" + it.id + "/state", { method: "PATCH", body: JSON.stringify(body) });
        if (out.res.ok) {
          shapeKey = body;
          done = true;
          break;
        }
        if (out.res.status === 401) {
          console.error("登录过期，已停止。成功 " + ok + "，失败 " + fail);
          return;
        }
      }
      if (done) ok += 1;
      else {
        fail += 1;
        console.warn("失败", it.id);
      }
      if ((i + 1) % 25 === 0) console.log("进度 " + (i + 1) + "/" + items.length + " 成功 " + ok + " 失败 " + fail);
      await sleep(400);
    }
    console.log("完成", { ok: ok, fail: fail, total: items.length });
  })();
})();`;
  }

  function officialPullScript() {
    return `(() => {
  const token = localStorage.getItem("daguan_token") || localStorage.getItem("token");
  if (!token) {
    console.error("未登录：请先登录大观园再运行。");
    return;
  }
  const hdr = () => {
    const h = { Accept: "application/json", Authorization: "Bearer " + token };
    const csrf = localStorage.getItem("csrf_token");
    if (csrf) h["X-CSRF-Token"] = csrf;
    return h;
  };
  async function api(path) {
    const res = await fetch("/api" + path, { credentials: "same-origin", headers: hdr(), cache: "no-store" });
    let data = null;
    try { data = await res.json(); } catch (e) {}
    return { res: res, data: data };
  }
  function toLocal(raw) {
    const s = String(raw || "").toLowerCase();
    if (s === "mastered" || s === "is_mastered" || s === "m") return "m";
    if (s === "not_known" || s === "notknown" || s === "forgot" || s === "f") return "f";
    if (s === "needs_practice" || s === "needspractice" || s === "learning" || s === "l") return "l";
    return "";
  }
  function ingest(node, map) {
    if (!node) return;
    if (Array.isArray(node)) {
      node.forEach(function (x) { ingest(x, map); });
      return;
    }
    if (typeof node !== "object") return;
    const id = node.question_id || node.questionId || node.id;
    const raw = node.mastery || node.mastery_level || node.level || node.status || node.state;
    const code = toLocal(raw);
    if (id != null && code && String(id).match(/^\\d+$/)) map[String(id)] = code;
    const action = String(node.action || node.flow_event || node.event_type || "");
    const qid = node.question_id || node.questionId;
    if (qid != null) {
      if (action.indexOf("mastered_mark") >= 0) map[String(qid)] = "m";
      else if (action.indexOf("not_known_mark") >= 0) map[String(qid)] = "f";
      else if (action.indexOf("needs_practice_mark") >= 0) map[String(qid)] = "l";
    }
    const keys = Object.keys(node);
    const looksFlat = keys.length && keys.every(function (k) { return /^\\d+$/.test(k) && typeof node[k] === "string"; });
    if (looksFlat) {
      keys.forEach(function (k) {
        const c = toLocal(node[k]);
        if (c) map[k] = c;
      });
      return;
    }
    keys.forEach(function (k) { ingest(node[k], map); });
  }
  (async () => {
    const me = await api("/auth/me");
    if (!me.res.ok) {
      console.error("登录无效，请刷新后重新登录。", me.res.status);
      return;
    }
    const map = {};
    const maps = [
      "/questions/mastery-map?include_children=true&scope=complete",
      "/questions/mastery-map?scope=complete",
      "/questions/mastery-map?include_children=true&scope=all",
    ];
    for (let i = 0; i < maps.length; i++) {
      const out = await api(maps[i]);
      if (out.res.ok) ingest(out.data, map);
    }
    for (let page = 1; page <= 80; page++) {
      const out = await api("/user/practice_events?page=" + page + "&per_page=100");
      if (!out.res.ok) break;
      const chunk = (out.data && (out.data.items || out.data.data || out.data.results)) || [];
      const list = Array.isArray(chunk) ? chunk : (chunk.items || []);
      if (!list.length) break;
      ingest(list, map);
      const total = out.data && (out.data.total || (out.data.data && out.data.data.total));
      if (total && page * 100 >= total) break;
    }
    const n = Object.keys(map).length;
    const payload = { v: 1, src: "cxyonly", at: Date.now(), map: map };
    const text = JSON.stringify(payload);
    let copied = false;
    try {
      await navigator.clipboard.writeText(text);
      copied = true;
    } catch (e) {}
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: "application/json" }));
    a.download = "daguan-from-official.json";
    a.click();
    console.log("已收集 " + n + " 题。" + (copied ? "进度 JSON 已复制到剪贴板。" : "剪贴板失败，请用下载的 json。") + "回到本地刷题站点「从剪贴板导入」。", payload);
  })();
})();`;
  }

  function parseProgressMap(text) {
    const data = JSON.parse(text);
    const map = {};
    const put = (id, code) => {
      const key = String(id);
      if (!key || code == null) return;
      if (code === "m" || code === "mastered") map[key] = "mastered";
      else if (code === "f" || code === "forgot" || code === "not_known") map[key] = "forgot";
      else if (code === "l" || code === "learning" || code === "needs_practice") map[key] = "learning";
    };
    if (data && data.map && typeof data.map === "object" && !Array.isArray(data.map)) {
      for (const [id, v] of Object.entries(data.map)) put(id, v);
      return map;
    }
    if (data && typeof data === "object" && !Array.isArray(data)) {
      for (const [id, v] of Object.entries(data)) {
        if (v && typeof v === "object" && v.mastery) put(id, v.mastery);
        else if (typeof v === "string") put(id, v);
      }
    }
    return map;
  }

  function applyImportedMap(map) {
    const ids = Object.keys(map);
    if (!ids.length) {
      toast("进度包是空的");
      return 0;
    }
    let n = 0;
    for (const id of ids) {
      const mastery = map[id];
      if (!mastery) continue;
      const cur = state.progress[id] || {};
      state.progress[id] = { ...cur, mastery, seen: true, updated_at: Date.now() };
      n += 1;
    }
    saveProgress();
    renderHome();
    if (state.view === "browse") {
      if (state.mode === "list") renderFeed(true);
      else renderSingle();
    }
    refreshSyncStats();
    updateStats();
    return n;
  }

  async function importProgressText(text) {
    const raw = String(text || "").trim();
    if (!raw) {
      toast("没有可导入的内容");
      return;
    }
    let map;
    try {
      map = parseProgressMap(raw);
    } catch {
      toast("JSON 解析失败，请检查粘贴内容");
      return;
    }
    const n = applyImportedMap(map);
    if (n) toast(`已写入本地 ${n} 题`);
  }

  function bindUI() {
    $("#btn-open-sidebar").addEventListener("click", () => els.sidebar.classList.add("open"));
    $("#btn-close-sidebar").addEventListener("click", () => els.sidebar.classList.remove("open"));
    $("#btn-home").addEventListener("click", goHome);
    $("#btn-brand").addEventListener("click", (e) => {
      e.preventDefault();
      goHome();
    });
    $("#nav-home").addEventListener("click", goHome);
    $("#nav-todo").addEventListener("click", () => openSpecial("todo"));
    $("#nav-forgot").addEventListener("click", () => openSpecial("forgot"));
    $("#btn-start").addEventListener("click", () => {
      const first = state.categories[0];
      if (first) openCategory(first.id);
    });

    $("#btn-prev").addEventListener("click", () => go(-1));
    $("#btn-next").addEventListener("click", () => go(1));
    $("#btn-toggle-answer").addEventListener("click", () => {
      state.showAnswer = !state.showAnswer;
      const q = currentQ();
      if (q && state.showAnswer) {
        const ok = gradeChoice(q, state.selected);
        if (ok != null) markAnswered(q.id, ok);
        else markSeen(q.id);
      }
      renderSingle();
    });
    $("#btn-shuffle").addEventListener("click", shuffleQueue);
    $("#btn-expand-all").addEventListener("click", expandAllAnswers);
    $("#btn-load-more").addEventListener("click", () => appendFeedPage());

    document.querySelectorAll(".mode-btn").forEach((btn) => {
      btn.addEventListener("click", () => setMode(btn.dataset.mode));
    });

    document.querySelectorAll(".scope-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        state.scope = btn.dataset.scope;
        document.querySelectorAll(".scope-btn").forEach((b) => {
          b.classList.toggle("active", b.dataset.scope === state.scope);
        });
        // sync checkbox
        if (state.scope === "core") {
          els.filterCore.checked = true;
          state.filterCore = true;
        }
        if (state.currentCatId != null) await openCategory(state.currentCatId, currentQ()?.id);
        else if (state.specialQueue) await openSpecial(state.specialQueue);
      });
    });

    $("#btn-reset-progress").addEventListener("click", () => {
      if (!confirm("确定清除本机全部做题进度？")) return;
      state.progress = {};
      saveProgress();
      renderHome();
      if (state.view === "browse") {
        if (state.mode === "list") renderFeed(true);
        else renderSingle();
      }
      toast("已清除本地进度");
    });

    document.querySelectorAll("[data-close]").forEach((el) => {
      el.addEventListener("click", () => closeSheet(el.dataset.close));
    });
    $("#btn-export").addEventListener("click", () => {
      refreshExportCounts();
      openSheet("dlg-export");
    });
    $("#btn-export-go").addEventListener("click", () => runExportPreview());
    $("#btn-print-back").addEventListener("click", closePrintPreview);
    $("#btn-copy-md").addEventListener("click", () => copyQuestionMarkdown(currentQ()));
    $("#btn-print-go").addEventListener("click", () => window.print());
    $("#export-answers").addEventListener("change", () => {
      const on = $("#export-answers").checked;
      $("#export-expl").disabled = !on;
      if (!on) $("#export-expl").checked = false;
    });

    $("#btn-sync").addEventListener("click", () => {
      refreshSyncStats();
      openSheet("dlg-sync");
    });
    $("#btn-download-progress").addEventListener("click", () => {
      downloadText(
        `daguan-progress-${isoDate()}.json`,
        JSON.stringify(buildProgressPayload(), null, 2),
        "application/json"
      );
      toast("已开始下载备份");
    });
    $("#btn-copy-script").addEventListener("click", async () => {
      const ok = await copyText(officialSyncScript());
      toast(ok ? "已复制，到大观园按 F12 打开控制台粘贴" : "复制失败，请改用下载备份");
    });
    document.querySelectorAll("[data-sync-tab]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const tab = btn.dataset.syncTab;
        document.querySelectorAll("[data-sync-tab]").forEach((b) => {
          b.classList.toggle("active", b.dataset.syncTab === tab);
        });
        $("#sync-panel-push").hidden = tab !== "push";
        $("#sync-panel-pull").hidden = tab !== "pull";
      });
    });
    $("#btn-copy-pull-script").addEventListener("click", async () => {
      const ok = await copyText(officialPullScript());
      toast(ok ? "已复制导出脚本，到大观园按 F12 粘贴" : "复制失败");
    });
    $("#btn-import-clipboard").addEventListener("click", async () => {
      try {
        const text = await navigator.clipboard.readText();
        await importProgressText(text);
      } catch {
        toast("读不到剪贴板，请把 JSON 贴进文本框再点写入");
      }
    });
    $("#btn-import-file").addEventListener("click", () => $("#import-file").click());
    $("#import-file").addEventListener("change", async () => {
      const file = $("#import-file").files && $("#import-file").files[0];
      if (!file) return;
      try {
        const text = await file.text();
        $("#import-text").value = text;
        await importProgressText(text);
      } catch (err) {
        toast("读取文件失败");
      }
      $("#import-file").value = "";
    });
    $("#btn-import-apply").addEventListener("click", () => importProgressText($("#import-text").value));
    $("#btn-pick-queue").addEventListener("click", () => {
      if (!state.queue.length) {
        toast("先打开一个分类");
        return;
      }
      for (const q of state.queue) state.picked.add(String(q.id));
      savePicked();
      toast(`已勾选当前列表 ${state.queue.length} 题`);
    });
    $("#btn-pick-clear").addEventListener("click", () => {
      state.picked.clear();
      savePicked();
      toast("已清空勾选");
    });
    $("#single-pick").addEventListener("change", () => {
      const q = currentQ();
      if (!q) return;
      setPicked(q.id, $("#single-pick").checked);
    });
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      if (document.body.classList.contains("print-preview")) {
        e.preventDefault();
        closePrintPreview();
      }
    });

    els.filterCore.addEventListener("change", async () => {
      state.filterCore = els.filterCore.checked;
      if (els.filterCore.checked) {
        state.scope = "core";
        document.querySelectorAll(".scope-btn").forEach((b) => {
          b.classList.toggle("active", b.dataset.scope === "core");
        });
      }
      if (state.currentCatId != null) await openCategory(state.currentCatId, currentQ()?.id);
      else if (state.specialQueue) await openSpecial(state.specialQueue);
    });
    els.filterTodo.addEventListener("change", async () => {
      state.filterTodo = els.filterTodo.checked;
      if (state.currentCatId != null) await openCategory(state.currentCatId, currentQ()?.id);
      else if (state.specialQueue) await openSpecial(state.specialQueue);
    });

    document.querySelectorAll("#single-mastery .chip[data-mastery]").forEach((el) => {
      el.addEventListener("click", () => {
        const q = currentQ();
        if (!q) return;
        setMastery(q.id, el.dataset.mastery);
      });
    });

    let searchTimer = null;
    els.search.addEventListener("focus", () => prefetchUrl(`${DATA}/search_index.json`), { once: true });
    els.search.addEventListener("input", () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => runSearch(els.search.value), 200);
    });

    document.addEventListener("keydown", (e) => {
      if (document.body.classList.contains("print-preview")) return;
      if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA")) return;
      if (state.view !== "browse") return;
      if (state.mode !== "single") return;
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        go(-1);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        go(1);
      } else if (e.key === "a" || e.key === "A") {
        e.preventDefault();
        $("#btn-toggle-answer").click();
      } else if (["1", "2", "3", "4"].includes(e.key)) {
        const i = Number(e.key) - 1;
        const btn = els.qOptions.children[i];
        if (btn) btn.click();
      }
    });
  }

  async function init() {
    bindUI();
    applyModeUI();
    try {
      indexesReady = Promise.all([
        fetchJSON(`${DATA}/category_questions.json`),
        fetchJSON(`${DATA}/id_index.json`),
      ]).then(([catQuestions, idIndex]) => {
        state.catQuestions = catQuestions;
        state.idIndex = idIndex;
      });
      const [manifest, categories] = await Promise.all([
        fetchJSON(`${DATA}/manifest.json`),
        fetchJSON(`${DATA}/categories.json`),
      ]);
      state.manifest = manifest;
      state.categories = categories;
      paintTree();
      renderHome();
      setView("home");
      refreshPickUI();
      indexesReady.then(() => renderHome()).catch(() => {});
    } catch (err) {
      console.error(err);
      els.stats.textContent = "数据加载失败";
      els.home.innerHTML = `<h1>加载失败</h1><p class="muted">${escapeHtml(err.message || String(err))}</p>
        <p>请用本地 HTTP 服务打开（不要直接双击 HTML）。例如：</p>
        <pre>cd site && python3 -m http.server 8765</pre>`;
    }
  }

  init();
})();
