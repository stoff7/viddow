(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const icon = (name) => {
    const node = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    node.setAttribute("class", "icon");
    node.setAttribute("aria-hidden", "true");
    const use = document.createElementNS(node.namespaceURI, "use");
    use.setAttribute("href", `#i-${name}`);
    node.append(use);
    return node;
  };
  const ACTIVE = new Set(["queued", "running", "cancelling"]);
  const STATUS = { queued: "В очереди", running: "Скачиваем", cancelling: "Останавливаем", done: "Готово", error: "Ошибка", cancelled: "Отменено" };
  const STATUS_ICON = { queued: "clock", running: "download", cancelling: "clock", done: "check", error: "info", cancelled: "x" };
  const viaServer = /^https?:$/.test(location.protocol);
  let jobs = [], filter = "all", online = false, polling = false, pollTimer;
  const cards = new Map();

  function setTheme(theme) {
    document.documentElement.dataset.theme = theme;
    $("themeLabel").textContent = theme === "dark" ? "Светлая тема" : "Тёмная тема";
    $("theme").setAttribute("aria-label", $("themeLabel").textContent);
    try { localStorage.setItem("viddow-theme", theme); } catch { /* storage может быть отключён */ }
  }
  let savedTheme;
  try { savedTheme = localStorage.getItem("viddow-theme"); } catch { /* file:// */ }
  setTheme(["light", "dark"].includes(savedTheme) ? savedTheme : matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  $("theme").onclick = () => setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");

  function message(text, error = false) {
    $("formMessage").hidden = !text;
    $("formMessage").textContent = text;
    $("formMessage").classList.toggle("error", error);
  }
  function toast(text) {
    $("toast").textContent = text;
    $("toast").hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { $("toast").hidden = true; }, 4000);
  }
  async function api(path, body) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch(path, { signal: controller.signal,
        ...(body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });
      if (!response.ok) throw new Error(await response.text());
      return await response.json();
    } catch (error) {
      if (error.name === "AbortError") throw new Error("Сервер не ответил. Проверьте подключение и список задач перед повтором.");
      if (error instanceof TypeError) throw new Error("Нет связи с локальным сервером.");
      throw error;
    } finally { clearTimeout(timeout); }
  }
  function setOnline(value) {
    online = value;
    $("connection").className = `connection ${value ? "online" : "offline"}`;
    $("connectionText").textContent = value ? "Локально · на вашем компьютере" : "Сервер недоступен";
    $("offline").hidden = value;
    $("downloadButton").disabled = !value || Boolean($("downloadForm").dataset.busy);
    updateSelection();
  }
  async function poll() {
    if (!viaServer || polling) return;
    clearTimeout(pollTimer);
    polling = true;
    try {
      const [items, health] = await Promise.all([api("/jobs"), api("/health")]);
      jobs = items;
      setOnline(true);
      renderJobs();
      const output = health.output_dir;
      $("outputFolder").textContent = output.endsWith("/Downloads") ? "Загрузки" : output;
      $("outputFolder").title = output;
      $("workerLabel").textContent = `Одновременно: ${health.workers}`;
      const missing = [];
      if (!health.tools.yt_dlp) missing.push("Для страниц с видео установите yt-dlp.");
      if (!health.tools.ffmpeg) missing.push("Для объединения видео и звука установите ffmpeg.");
      $("toolWarning").hidden = !missing.length;
      $("toolWarning").textContent = missing.join(" ") + " Подробнее — в справке.";
      $("toolStatus").textContent = `yt-dlp: ${health.tools.yt_dlp ? "найден" : "не найден"}. ffmpeg: ${health.tools.ffmpeg ? "найден" : "не найден"}.`;
    } catch {
      setOnline(false);
    } finally {
      polling = false;
      pollTimer = setTimeout(poll, online && jobs.some((job) => ACTIVE.has(job.status)) ? 750 : 3000);
    }
  }

  function urlParts(url) {
    try {
      const parsed = new URL(url);
      return { host: parsed.hostname, name: decodeURIComponent(parsed.pathname.split("/").filter(Boolean).pop() || parsed.hostname) };
    } catch { return { host: "Источник", name: url }; }
  }
  function makeCard(job) {
    const root = el("article", "job");
    root.dataset.id = job.id;
    const emblem = el("div", "job-icon");
    emblem.append(icon("video"));
    const body = el("div", "job-body");
    const title = el("div", "job-title");
    const source = el("div", "job-source");
    const meta = el("div", "job-meta");
    const status = el("span", "job-status");
    const label = el("span", "job-label");
    const progress = el("div", "progress");
    progress.setAttribute("role", "progressbar");
    progress.setAttribute("aria-valuemin", "0");
    progress.setAttribute("aria-valuemax", "100");
    const fill = el("span");
    progress.append(fill);
    const error = el("p", "job-error");
    const actions = el("div", "job-actions");
    meta.append(status, label);
    body.append(title, source, meta, progress, error);
    root.append(emblem, body, actions);
    return { root, title, source, status, label, progress, fill, error, actions, actionKey: "" };
  }
  function actionButton(text, iconName, callback) {
    const button = el("button", "text-button", text);
    button.prepend(icon(iconName));
    button.onclick = async () => {
      button.disabled = true;
      try { await callback(); } catch (error) { toast(error.message); }
      finally { button.disabled = false; }
    };
    return button;
  }
  async function jobAction(job, action) {
    await api(`/jobs/${job.id}/${action}`, {});
    if (action === "retry") { setFilter("all"); toast("Новая попытка добавлена в очередь"); }
    await poll();
  }
  function renderJobs() {
    const active = jobs.filter((job) => ACTIVE.has(job.status)).length;
    $("totalCount").textContent = jobs.length;
    $("navCount").textContent = jobs.length;
    $("activeCount").textContent = active;
    $("doneCount").textContent = jobs.filter((job) => job.status === "done").length;
    $("clearJobs").disabled = !jobs.some((job) => !ACTIVE.has(job.status));
    const existing = new Set(jobs.map((job) => job.id));
    for (const [id, card] of cards) {
      if (!existing.has(id)) { card.root.remove(); cards.delete(id); }
    }
    let visible = 0;
    [...jobs].reverse().forEach((job, index) => {
      let card = cards.get(job.id);
      if (!card) { card = makeCard(job); cards.set(job.id, card); }
      if ($("jobList").children[index] !== card.root) $("jobList").insertBefore(card.root, $("jobList").children[index] || null);
      card.root.className = `job ${job.status}`;
      card.root.hidden = filter === "active" ? !ACTIVE.has(job.status) : filter === "done" && job.status !== "done";
      if (!card.root.hidden) visible++;
      const parts = urlParts(job.url);
      const name = job.path ? job.path.split(/[\\/]/).pop() : job.name || parts.name;
      card.title.textContent = name;
      card.title.title = job.path || job.url;
      card.source.textContent = parts.host;
      card.source.title = job.url;
      card.label.textContent = ACTIVE.has(job.status) ? job.label : "";
      const percent = job.fraction == null ? null : Math.round(Math.max(0, Math.min(1, job.fraction)) * 100);
      card.status.replaceChildren(icon(STATUS_ICON[job.status] || "info"), document.createTextNode(STATUS[job.status] + (job.status === "running" && percent !== null ? ` · ${percent}%` : "")));
      card.progress.hidden = job.status !== "running" && job.status !== "cancelling";
      card.progress.classList.toggle("indeterminate", percent === null);
      card.progress.setAttribute("aria-label", `Скачивание: ${name}`);
      if (percent === null) card.progress.removeAttribute("aria-valuenow");
      else card.progress.setAttribute("aria-valuenow", percent);
      card.fill.style.width = percent === null ? "" : `${percent}%`;
      card.error.hidden = !job.error;
      card.error.textContent = job.error || "";
      const actionKey = `${job.status}:${job.path || ""}`;
      if (card.actionKey !== actionKey) {
        card.actionKey = actionKey;
        card.actions.replaceChildren();
        if (["queued", "running"].includes(job.status)) card.actions.append(actionButton("Отменить", "x", () => jobAction(job, "cancel")));
        if (["error", "cancelled"].includes(job.status)) card.actions.append(actionButton("Повторить", "retry", () => jobAction(job, "retry")));
        if (job.status === "done") card.actions.append(actionButton("Копировать путь", "copy", async () => { await copy(job.path); toast("Путь к файлу скопирован"); }));
      }
    });
    $("emptyState").hidden = visible > 0;
    $("firstLink").hidden = jobs.length > 0;
    $("emptyTitle").textContent = jobs.length ? (filter === "done" ? "Готовых загрузок пока нет" : "Все задачи завершены") : "Здесь начинается ваша коллекция";
    $("emptyText").textContent = jobs.length ? "Выберите другой фильтр или добавьте новую ссылку." : "Вставьте ссылку выше. Мы сохраним видео, а здесь покажем, как идёт загрузка.";
  }
  function setFilter(next) {
    filter = next;
    document.querySelectorAll("[data-filter]").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.filter === filter)));
    renderJobs();
  }
  document.querySelectorAll("[data-filter]").forEach((button) => { button.onclick = () => setFilter(button.dataset.filter); });
  $("clearJobs").onclick = async () => {
    $("clearJobs").disabled = true;
    try { await api("/jobs/clear", {}); await poll(); toast("Список очищен. Файлы остались на компьютере."); }
    catch (error) { toast(error.message); }
    finally { renderJobs(); }
  };
  function validUrl(value) {
    try { const url = new URL(value); return /^https?:$/.test(url.protocol) && Boolean(url.hostname); } catch { return false; }
  }
  $("downloadForm").onsubmit = async (event) => {
    event.preventDefault();
    const url = $("url").value.trim();
    if (!validUrl(url)) { message("Вставьте адрес, начинающийся с http:// или https://", true); return; }
    $("downloadForm").dataset.busy = "1";
    $("downloadButton").disabled = true;
    message("");
    try {
      await api("/download", { urls: [url], name: $("name").value.trim(), source_kind: $("sourceKind").value });
      // Не стираем другую ссылку, которую пользователь успел ввести во время запроса.
      if ($("url").value.trim() === url) $("url").value = "";
      message("Добавлено в очередь. За загрузкой можно следить ниже.");
      setFilter("all");
      await poll();
    } catch (error) { message(error.message, true); }
    finally { delete $("downloadForm").dataset.busy; $("downloadButton").disabled = !online; }
  };
  $("paste").onclick = async () => {
    try { $("url").value = (await navigator.clipboard.readText()).trim(); $("url").focus(); }
    catch { $("url").focus(); message("Вставьте ссылку с клавиатуры: ⌘V на Mac или Ctrl+V."); }
  };
  $("firstLink").onclick = () => { $("url").focus(); $("url").scrollIntoView({ block: "center" }); };
  $("openHelp").onclick = () => $("help").showModal();
  $("closeHelp").onclick = () => $("help").close();
  $("openTools").onclick = () => { $("tools").open = true; $("tools").scrollIntoView({ block: "start" }); $("base").focus({ preventScroll: true }); };

  async function copy(text) {
    try { await navigator.clipboard.writeText(text); }
    catch {
      const field = el("textarea", "visually-hidden");
      field.value = text;
      document.body.append(field);
      field.select();
      const copied = document.execCommand("copy");
      field.remove();
      if (!copied) throw new Error("Не удалось скопировать. Выделите текст вручную.");
    }
  }

  // Дополнительный сценарий: извлечение ссылок из HTML.
  let found = [], page = { title: "", base: "" }, extractTimer;
  function selected() { return [...$("foundLinks").querySelectorAll("input:checked")].map((input) => found[Number(input.value)]); }
  const shq = (value) => "'" + value.replace(/'/g, "'\\''") + "'";
  function updateSelection() {
    const items = selected();
    $("selectAll").checked = Boolean(found.length) && items.length === found.length;
    $("selectAll").indeterminate = items.length > 0 && items.length < found.length;
    $("copyLinks").disabled = !items.length;
    $("copyCommand").disabled = !items.length;
    $("downloadSelected").disabled = !online || !items.length || Boolean($("downloadSelected").dataset.busy);
    const options = [];
    if (page.title && items.length === 1) options.push("-n", shq(page.title));
    if (page.base) options.push("--referer", shq(page.base));
    $("commandText").textContent = items.length ? ["python3 download.py", ...options, ...items.map((item) => shq(item.url))].join(" ") : "Выберите найденные ссылки.";
  }
  function extract() {
    ({ items: found, ...page } = window.videoExtractor.extract($("htmlSource").value, $("base").value.trim()));
    $("foundCount").textContent = found.length ? `Найдено: ${found.length}` : "Ссылок нет";
    $("foundLinks").replaceChildren(...found.map((item, index) => {
      const li = el("li");
      const checkbox = el("input");
      checkbox.type = "checkbox"; checkbox.value = index; checkbox.id = `found-${index}`;
      checkbox.checked = item.kind !== "embed";
      checkbox.onchange = updateSelection;
      const label = el("label", "", item.url);
      label.htmlFor = checkbox.id;
      label.append(el("span", "found-kind", `${item.kind === "embed" ? "Плеер" : (item.ext || "Видео").toUpperCase()} · ${[...item.sources].join(", ")}`));
      const link = el("a", "", "Открыть");
      link.href = item.url; link.target = "_blank"; link.rel = "noopener noreferrer";
      li.append(checkbox, label, link);
      return li;
    }));
    updateSelection();
  }
  function scheduleExtract() { clearTimeout(extractTimer); extractTimer = setTimeout(extract, 250); }
  $("htmlSource").oninput = scheduleExtract;
  $("base").oninput = scheduleExtract;
  $("selectAll").onchange = () => { $("foundLinks").querySelectorAll("input").forEach((input) => { input.checked = $("selectAll").checked; }); updateSelection(); };
  $("clearHtml").onclick = () => { $("htmlSource").value = ""; $("base").value = ""; $("htmlStatus").textContent = ""; extract(); };
  $("copyLinks").onclick = async () => { try { await copy(selected().map((item) => item.url).join("\n")); toast("Ссылки скопированы"); } catch (error) { toast(error.message); } };
  $("copyCommand").onclick = async () => { try { await copy($("commandText").textContent); toast("Команда скопирована"); } catch (error) { toast(error.message); } };
  $("loadHtml").onclick = async () => {
    const url = $("base").value.trim();
    if (!validUrl(url)) { $("htmlStatus").textContent = "Введите HTTP(S)-адрес страницы."; return; }
    if (!viaServer) { $("htmlStatus").textContent = "Для загрузки страницы запустите python3 server.py."; return; }
    $("loadHtml").disabled = true;
    $("htmlStatus").textContent = "Загружаем страницу…";
    try {
      const response = await fetch(`/fetch?url=${encodeURIComponent(url)}`, { signal: AbortSignal.timeout(35000) });
      const text = await response.text();
      if (!response.ok) throw new Error(text);
      $("htmlSource").value = text;
      $("base").value = decodeURI(response.headers.get("X-Final-Url") || url);
      extract();
      $("htmlStatus").textContent = found.length ? `Найдено ссылок: ${found.length}` : "Ссылки не найдены. Попробуйте расширение.";
    } catch (error) { $("htmlStatus").textContent = error.message; }
    finally { $("loadHtml").disabled = false; }
  };
  $("downloadSelected").onclick = async () => {
    const items = selected();
    $("downloadSelected").dataset.busy = "1";
    updateSelection();
    try {
      await api("/download", { urls: items.map((item) => item.url), name: items.length === 1 ? page.title : "", referer: page.base, page: page.base });
      setFilter("all"); await poll(); toast(`Добавлено в очередь: ${items.length}`);
    } catch (error) { toast(error.message); }
    finally { delete $("downloadSelected").dataset.busy; updateSelection(); }
  };
  async function loadFile(file) {
    if (!file) return;
    if (file.size > 20 * 1024 * 1024) { $("htmlStatus").textContent = "Файл больше 20 МБ."; return; }
    try { $("htmlSource").value = await file.text(); extract(); $("htmlStatus").textContent = file.name; }
    catch { $("htmlStatus").textContent = "Не удалось прочитать файл."; }
  }
  $("htmlFile").onchange = (event) => loadFile(event.target.files[0]);
  $("htmlSource").ondragover = (event) => { event.preventDefault(); $("htmlSource").classList.add("drag"); };
  $("htmlSource").ondragleave = () => $("htmlSource").classList.remove("drag");
  $("htmlSource").ondrop = (event) => { event.preventDefault(); $("htmlSource").classList.remove("drag"); loadFile(event.dataTransfer.files[0]); };

  $("downloadButton").disabled = true;
  if (viaServer) poll();
  else {
    setOnline(false);
    $("offline").textContent = "Для скачивания запустите python3 server.py и откройте адрес, указанный в терминале. Поиск по вставленному HTML доступен и здесь.";
  }
})();
