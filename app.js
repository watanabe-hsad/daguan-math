(() => {
  "use strict";

  const DATA = "./data";
  const PROGRESS_KEY = "daguan_local_progress_v1";
  const MODE_KEY = "daguan_local_mode_v1";
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

  async function fetchJSON(path) {
    const res = await fetch(path);
    if (!res.ok) throw new Error(`加载失败 ${path}: ${res.status}`);
    return res.json();
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

  async function ensureShard(name) {
    if (state.shards.has(name)) return state.shards.get(name);
    const meta = state.manifest.shards[name];
    if (!meta) throw new Error("未知分片: " + name);
    const list = await fetchJSON(`${DATA}/${meta.file}`);
    const map = new Map(list.map((q) => [q.id, q]));
    state.shards.set(name, map);
    return map;
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

    const head = document.createElement("div");
    head.className = "q-card-head";
    head.innerHTML = `
      <div class="q-card-index">
        <span class="q-num">${index + 1}</span>
        <span class="mastery-badge" data-mastery="${mastery}">${MASTERY_LABEL[mastery]}</span>
      </div>
      <div class="q-card-tags">
        ${q.is_core ? `<span class="pill core">核心</span>` : ""}
        <span class="pill">${escapeHtml(q.source || "未知来源")}</span>
        <span class="pill soft">${escapeHtml(TYPE_LABEL[q.type] || q.type || "题目")}</span>
        <span class="pill soft">#${q.id}</span>
      </div>`;

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

    actions.append(ansBtn, focusBtn);

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
        <div class="s-top">
          <span>#${h.id}</span>
          <span>${escapeHtml(h.source || "")}</span>
          <span>${escapeHtml(TYPE_LABEL[h.type] || h.type || "")}</span>
          <span>${escapeHtml(h.path || "")}</span>
        </div>
        <div class="s-stem">${escapeHtml(stripMd(h.stem || ""))}</div>`;
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
    els.search.addEventListener("input", () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => runSearch(els.search.value), 200);
    });

    document.addEventListener("keydown", (e) => {
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
      const [manifest, categories, catQuestions, idIndex] = await Promise.all([
        fetchJSON(`${DATA}/manifest.json`),
        fetchJSON(`${DATA}/categories.json`),
        fetchJSON(`${DATA}/category_questions.json`),
        fetchJSON(`${DATA}/id_index.json`),
      ]);
      state.manifest = manifest;
      state.categories = categories;
      state.catQuestions = catQuestions;
      state.idIndex = idIndex;
      paintTree();
      renderHome();
      setView("home");
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
