// Извлечение ссылок из инертного HTML. Скрипты страницы не выполняются.
(() => {
const VIDEO_EXT = ["mp4", "m4v", "webm", "mov", "mkv", "avi", "flv", "ogv", "3gp", "wmv", "ts", "m3u8", "mpd"];
const STREAM_EXT = ["m3u8", "mpd"];
const EMBED_HOSTS = /(youtube\.com|youtube-nocookie\.com|youtu\.be|vimeo\.com|rutube\.ru|vk\.com|vkvideo\.ru|ok\.ru|dailymotion\.com|dzen\.ru)/i;
// iframe с неизвестного сайта считаем плеером, если адрес на него похож
const EMBED_HINT = /(embed|player|video|movie|film|serial|episode|stream)/i;
const NOT_PLAYER = /(recaptcha|captcha|googletagmanager|doubleclick|googlesyndication|facebook\.com\/plugins|platform\.twitter|disqus|yandex\.ru\/(ads|metrika))/i;
const URL_IN_TEXT = /https?:\/\/[^\s"'<>`\\)\]}]+/gi;

function extOf(url) {
  try {
    const m = new URL(url).pathname.toLowerCase().match(/\.([a-z0-9]{2,4})$/);
    return m ? m[1] : "";
  } catch { return ""; }
}

function resolve(raw, base) {
  if (!raw) return null;
  raw = raw.trim().replace(/&amp;/g, "&");
  if (/^(blob:|data:|javascript:|#)/i.test(raw)) return null;
  try { return new URL(raw, base || undefined).href; } catch { return null; }
}

function guessBase(doc) {
  const el = doc.querySelector("base[href], link[rel=canonical], meta[property='og:url']");
  return el ? (el.getAttribute("href") || el.getAttribute("content")) : "";
}

function extract(html, userBase) {
  const doc = new DOMParser().parseFromString(html, "text/html"); // инертный: скрипты не выполняются
  let base = userBase;
  if (!base) { try { base = new URL(guessBase(doc)).href; } catch { base = ""; } }

  const map = new Map();
  const add = (raw, source, kind) => {
    const url = resolve(raw, base);
    if (!url || !/^https?:/i.test(url)) return;
    const ext = extOf(url);
    kind = kind || (STREAM_EXT.includes(ext) ? "stream" : "direct");
    if (!map.has(url)) map.set(url, { url, kind, ext, sources: new Set() });
    map.get(url).sources.add(source);
  };
  const isVideo = (u) => VIDEO_EXT.includes(extOf(resolve(u, base) || ""));

  doc.querySelectorAll("video[src]").forEach((el) => add(el.getAttribute("src"), "<video>"));
  doc.querySelectorAll("video source[src], source[type^='video'], source[type*='mpegurl' i]")
    .forEach((el) => add(el.getAttribute("src"), "<source>"));
  doc.querySelectorAll("[data-src], [data-video], [data-video-src], [data-url]").forEach((el) => {
    for (const a of ["data-src", "data-video", "data-video-src", "data-url"]) {
      const v = el.getAttribute(a);
      if (v && isVideo(v)) add(v, a);
    }
  });
  doc.querySelectorAll("meta[property^='og:video'], meta[name^='twitter:player:stream']").forEach((el) => {
    const v = el.getAttribute("content");
    if (v && /^(https?:|\/)/i.test(v)) add(v, el.getAttribute("property") || el.getAttribute("name"),
      isVideo(v) ? null : "embed");
  });
  doc.querySelectorAll("a[href]").forEach((el) => {
    const v = el.getAttribute("href");
    if (isVideo(v)) add(v, "ссылка <a>");
  });
  doc.querySelectorAll("iframe[src], iframe[data-src], embed[src]").forEach((el) => {
    const v = el.getAttribute("src") || el.getAttribute("data-src"); // data-src — ленивая загрузка
    const url = resolve(v, base);
    if (!url || NOT_PLAYER.test(url)) return;
    if (EMBED_HOSTS.test(url) || EMBED_HINT.test(url)) add(v, "<iframe>", "embed");
  });

  // Ссылки внутри скриптов и JSON, в т.ч. экранированные: https:\/\/cdn\/v.mp4?a=1&b=2
  const text = html
    .replace(/\\u002f/gi, "/").replace(/\\u0026/gi, "&").replace(/\\u003d/gi, "=")
    .replace(/\\\//g, "/");
  for (const m of text.matchAll(URL_IN_TEXT)) {
    const u = m[0].replace(/[.,;]+$/, "");
    if (isVideo(u)) add(u, "в коде/скрипте");
  }

  const order = { direct: 0, stream: 1, embed: 2 };
  return {
    items: [...map.values()].sort((a, b) => order[a.kind] - order[b.kind]),
    title: (doc.querySelector("meta[property='og:title']")?.getAttribute("content") || doc.title).trim(),
    base,
  };
}


window.videoExtractor = { extract };
})();
