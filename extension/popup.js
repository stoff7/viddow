// Окно расширения: потоки, пойманные background.js на текущей вкладке, и загрузки с прогрессом.
// Качает background.js через native_host.py; здесь только показываем storage.session и шлём команды.
const HOST = "local.video_downloader";
const $ = (id) => document.getElementById(id);
const el = (tag, className, text) =>
  Object.assign(document.createElement(tag), className ? { className } : {}, text != null ? { textContent: text } : {});

const STATUS = { running: "качается", done: "готово", error: "ошибка", cancelled: "отменено" };

const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
const tabKey = `tab_${tab.id}`;

function renderStreams(items) {
  $("streams").replaceChildren(...items.map((item) => {
    const { host, pathname } = new URL(item.url);
    const url = el("div", "url");
    url.append(el("span", "badge", item.kind), pathname.split("/").pop() || pathname);
    url.title = item.url;
    const body = el("div");
    body.append(url, el("div", "meta", host));

    const button = el("button", "primary", "Скачать");
    button.onclick = () => {
      // сырой заголовок и адрес вкладки — имя файла сделает download.nice_name()
      chrome.runtime.sendMessage({ type: "download", item, title: tab.title, page: tab.url });
      button.disabled = true;
      button.textContent = "Качается";
    };
    const row = el("div", "row");
    row.append(body, button);
    const li = el("li");
    li.append(row);
    return li;
  }));
  $("streamsHint").textContent = items.length
    ? "Первый в списке обычно master-плейлист: качается лучшее качество и все озвучки."
    : "Пока ничего. Запустите видео в плеере — поток появится здесь.";
}

function renderJobs(jobs) {
  $("jobsSection").hidden = !jobs.length;
  $("jobs").replaceChildren(...jobs.map((job) => {
    const li = el("li", job.status);
    const name = job.path ? job.path.split("/").pop() : job.title || job.url;
    const title = el("div", "name", name);
    title.title = job.path || job.url;

    const actions = el("div");
    if (job.status === "running") {
      const cancel = el("button", "", "Отмена");
      cancel.onclick = () => chrome.runtime.sendMessage({ type: "cancel", id: job.id });
      actions.append(cancel);
    } else if (job.status === "done") {
      const show = el("button", "", "В Finder");
      show.onclick = () => chrome.runtime.sendNativeMessage(HOST, { type: "reveal", path: job.path })
        .then((r) => { if (r?.type === "error") show.textContent = "Файла нет"; })
        .catch(() => { show.textContent = "Хост не установлен"; });
      actions.append(show);
    }
    const row = el("div", "row");
    row.append(title, actions);

    const bar = el("div", "bar");
    const fill = el("span");
    if (job.status === "running" && job.fraction == null) bar.classList.add("indeterminate");
    else fill.style.width = (job.status === "done" ? 100 : (job.fraction || 0) * 100) + "%";
    bar.append(fill);

    const percent = job.status === "running" && job.fraction != null ? ` ${Math.round(job.fraction * 100)}%` : "";
    const details = job.error || (job.status === "running" ? job.label : "");
    const meta = el("div", "meta " + job.status, STATUS[job.status] + percent + (details ? " · " + details : ""));

    li.append(row);
    if (job.status === "running" || job.status === "done") li.append(bar);
    li.append(meta);
    return li;
  }));
}

$("clear").onclick = () => chrome.runtime.sendMessage({ type: "clear" });
// Страница целиком: download.py увидит HTML и отдаст его yt-dlp. Ссылки на потоки у VK и подобных
// живут минуты и бывают одноразовыми, а по адресу страницы yt-dlp каждый раз берёт свежую.
$("page").hidden = !/^https?:/.test(tab.url || "");
$("page").onclick = () => {
  chrome.runtime.sendMessage({ type: "download", item: { url: tab.url }, title: tab.title, page: tab.url });
  $("page").disabled = true;
  $("page").textContent = "Отправлено";
};

const stored = await chrome.storage.session.get([tabKey, "jobs"]);
renderStreams(stored[tabKey] || []);
renderJobs(stored.jobs || []);
chrome.storage.session.onChanged.addListener((changes) => {
  if (changes.jobs) renderJobs(changes.jobs.newValue || []);
  if (changes[tabKey]) renderStreams(changes[tabKey].newValue || []);
});
