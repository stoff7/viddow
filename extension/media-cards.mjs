import { mainFormats, qualityLabel, audioLabel, defaultChoice, choiceProblem, formatLabel } from './format-model.mjs';

const node = (tag, className, text) => Object.assign(document.createElement(tag),
  { className }, text === undefined ? {} : { textContent: text });
const ACTIVE = new Set(['queued', 'running', 'cancelling']);
const STATUS = { queued: 'В очереди', running: 'Скачиваем', cancelling: 'Останавливаем…',
  done: 'Скачано', error: 'Ошибка', cancelled: 'Отменено', interrupted: 'Прервано' };

// DOM presentation only: no inspection, preview capture, timers or storage here.
export class MediaCards {
  constructor(list, io) { this.list = list; this.io = io; this.cards = new Map(); this.sequence = 0; }
  create(key) {
    const root = node('li', 'media-card');
    const artwork = node('button', 'media-artwork'), image = node('img', ''); artwork.type = 'button';
    image.alt = ''; image.referrerPolicy = 'no-referrer';
    const missing = node('span', 'media-placeholder', 'Нет превью'), duration = node('span', 'media-duration');
    image.onerror = () => { image.hidden = true; missing.hidden = false; };
    artwork.append(image, missing, duration);
    const body = node('div', 'media-body'), title = node('h2', 'media-title');
    const formats = node('div', 'media-formats'), quality = node('select', '');
    const id = `media-choice-${++this.sequence}`;
    quality.id = id;
    const qualityLabelNode = node('label', '', 'Качество'); qualityLabelNode.htmlFor = id;
    const qualityField = node('div', ''); qualityField.append(qualityLabelNode, quality);
    const audio = node('details', 'media-audio'), audioSummary = node('summary', '', 'Озвучка');
    const audioFields = node('fieldset', ''); audioFields.append(node('legend', 'visually-hidden', 'Звуковые дорожки'));
    audio.append(audioSummary, audioFields); formats.append(qualityField, audio);
    const status = node('p', 'media-status'), progress = node('progress', ''); progress.max = 1;
    const actions = node('div', 'media-actions'), primary = node('button', 'button primary', 'Скачать');
    primary.type = 'button';
    const menu = node('details', 'media-menu'), summary = node('summary', '', '⋯');
    const tools = node('div', 'media-tools'), source = node('code', ''), detail = node('code', '');
    const recheck = node('button', 'text-button', 'Повторить анализ'), queue = node('button', 'text-button', 'Все загрузки');
    const direct = node('button', 'text-button', 'Скачать без выбора качества');
    const cancelPreparation = node('button', 'text-button', 'Отменить подготовку');
    recheck.type = queue.type = direct.type = cancelPreparation.type = 'button';
    tools.append(source, detail, cancelPreparation, recheck, direct, queue); menu.append(summary, tools); actions.append(primary, menu);
    const jobs = node('div', 'media-jobs');
    body.append(title, formats, status, progress, actions, jobs); root.append(artwork, body);
    const card = { root, artwork, image, missing, duration, title, formats, quality, audio, audioFields,
      audioSummary, status, progress, primary, summary, source, detail, recheck, direct, cancelPreparation, jobs, jobNodes: new Map(), busy: false };
    const run = async callback => {
      if (card.busy) return;
      card.busy = true; primary.disabled = true;
      try { await callback(); } catch (error) { this.io.error(error.message); }
      finally { card.busy = false; if (this.cards.get(key) === card) this.update(card, card.row, card.context); }
    };
    primary.onclick = () => run(async () => {
      const row = card.row;
      if (row.pending) return this.io.cancel(row);
      if (card.principal) return this.io.job(card.principal.status === 'done' ? 'reveal'
        : ACTIVE.has(card.principal.status) ? 'cancel' : 'retry', card.principal, row.session);
      if (row.result) {
        const choice = this.choice(card);
        const problem = choiceProblem(choice.main, choice.audio, card.context.ffmpeg, choice.silent);
        if (problem) { this.io.error(problem); return; }
        await this.io.download(row, [choice.main.id, ...choice.audio]);
      } else await this.io.prepare(row, true);
    });
    artwork.onclick = () => run(() => this.io.prepare(card.row, false));
    recheck.onclick = () => run(() => this.io.prepare(card.row, false));
    direct.onclick = () => run(() => this.io.direct(card.row));
    cancelPreparation.onclick = () => run(() => this.io.cancel(card.row));
    queue.onclick = () => this.io.queue();
    quality.onchange = () => { card.silent.checked = false; this.update(card, card.row, card.context); };
    this.cards.set(key, card); this.list.append(root); return card;
  }
  choice(card) {
    const main = card.row.result?.formats.find(format => format.id === card.quality.value);
    return { main,
      audio: main?.kind !== 'video' || card.silent?.checked ? []
        : [...card.audioFields.querySelectorAll('input[data-audio]:checked')].map(input => input.value),
      silent: main?.kind === 'video' && Boolean(card.silent?.checked) };
  }
  update(card, row, context) {
    card.row = row; card.context = context;
    card.title.textContent = row.title; card.title.title = row.title;
    card.artwork.setAttribute('aria-label', `Выбрать видео «${row.title}»`);
    card.artwork.setAttribute('aria-pressed', String(Boolean(row.selected)));
    card.root.classList.toggle('selected', Boolean(row.selected));
    card.artwork.disabled = !context.online || context.inspectPending || card.busy || row.pending || row.preparing;
    card.summary.setAttribute('aria-label', `Действия для «${row.title}»`);
    card.duration.textContent = row.duration || ''; card.duration.hidden = !row.duration;
    // Keep broken-image fallback until the source actually changes.
    if (card.image.dataset.source !== (row.image || '')) {
      card.image.dataset.source = row.image || '';
      card.image.hidden = !row.image; card.missing.hidden = Boolean(row.image);
      if (row.image) card.image.src = row.image; else card.image.removeAttribute('src');
    }
    if (!card.image.hasAttribute('src')) card.image.hidden = true;
    card.formats.hidden = !row.result || row.jobs.length > 0;
    const signature = row.result ? `${row.session}:${row.analysisId}:${row.result.source_id || row.result.id || ''}` : '';
    if (signature && signature !== card.formatSignature) {
      const result = row.result, defaults = defaultChoice(result.formats, context.ffmpeg);
      const formats = mainFormats(result.formats), labels = formats.map(qualityLabel);
      card.quality.replaceChildren(...formats.map((format, index) => Object.assign(node('option', '',
        labels.filter(label => label === labels[index]).length > 1 ? `${labels[index]} · ${format.id}` : labels[index]),
      { value: format.id, selected: format.id === defaults.main })));
      const audio = result.formats.filter(format => format.kind === 'audio');
      card.audioFields.replaceChildren(node('legend', 'visually-hidden', 'Звуковые дорожки'));
      for (const format of audio) {
        const label = node('label', 'audio-option'), input = node('input', '');
        input.type = 'checkbox'; input.value = format.id; input.dataset.audio = '';
        input.id = `media-audio-${++this.sequence}`; label.htmlFor = input.id;
        input.checked = defaults.audio.includes(format.id);
        input.onchange = () => { if (input.checked) card.silent.checked = false; this.update(card, card.row, card.context); };
        label.append(input, node('span', '', `${audioLabel(format)}${audio.filter(item => audioLabel(item) === audioLabel(format)).length > 1 ? ` · ${format.id}` : ''}`));
        card.audioFields.append(label);
      }
      const silentLabel = node('label', 'audio-option'), silent = node('input', '');
      silent.type = 'checkbox'; silent.id = `media-silent-${++this.sequence}`; silentLabel.htmlFor = silent.id;
      silentLabel.append(silent, node('span', '', 'Без звука')); card.audioFields.append(silentLabel); card.silent = silent;
      silent.onchange = () => {
        if (silent.checked) card.audioFields.querySelectorAll('input[data-audio]').forEach(input => { input.checked = false; });
        this.update(card, card.row, card.context);
      };
      card.formatSignature = signature;
    }
    const choice = this.choice(card);
    card.audio.hidden = choice.main?.kind !== 'video';
    card.audioSummary.textContent = choice.silent ? 'Без звука' : choice.audio.length === 1
      ? audioLabel(row.result.formats.find(format => format.id === choice.audio[0]))
      : choice.audio.length ? `Озвучка · ${choice.audio.length}` : 'Выбрать озвучку';
    const problem = row.result ? choiceProblem(choice.main, choice.audio, context.ffmpeg, choice.silent) : '';
    card.principal = row.jobs.findLast(job => ACTIVE.has(job.status)) || row.jobs.findLast(job => job.status === 'done') || row.jobs.at(-1);
    const job = card.principal;
    card.status.textContent = row.pending ? 'Начнём после подготовки'
      : row.preparing ? 'Определяем качество…' : row.error || row.note || (row.result ? problem || (choice.main?.kind === 'unknown'
        ? 'Состав дорожек неизвестен' : choice.main?.kind === 'audio' ? 'Только звук' : '') : job ? '' : 'Качество и звук ещё не определены');
    if (job) card.status.textContent = '';
    card.status.hidden = !card.status.textContent;
    card.status.classList.toggle('error', Boolean(row.error));
    card.progress.hidden = !row.preparing; card.progress.removeAttribute('value');
    card.progress.setAttribute('aria-label', `Подготовка «${row.title}»`);
    card.primary.textContent = row.pending ? 'Отменить' : job ? job.status === 'done' ? 'Показать файл'
      : ACTIVE.has(job.status) ? 'Отменить' : 'Повторить' : row.error ? 'Попробовать снова' : 'Скачать ↓';
    card.primary.setAttribute('aria-label', `${card.primary.textContent} «${row.title}»`);
    card.primary.disabled = card.busy || !context.online || (job ? job.status === 'cancelling'
      || job.status === 'done' && (!job.path || job.file_exists === false)
      || !ACTIVE.has(job.status) && job.status !== 'done' && (!['error', 'cancelled'].includes(job.status) || job.restored)
      : !row.pending && (context.inspectPending || Boolean(problem)));
    card.recheck.disabled = !context.online || context.inspectPending || row.pending || row.jobs.some(job => ACTIVE.has(job.status));
    card.direct.disabled = !context.online || card.busy || row.pending || row.jobs.some(job => ACTIVE.has(job.status));
    card.cancelPreparation.hidden = !row.preparing || row.pending;
    card.cancelPreparation.disabled = !context.online || card.busy;
    const announcement = row.pending ? 'Начнём после подготовки' : job && job.status !== 'done' && !job.restored
      ? STATUS[job.status] : row.error || '';
    if (announcement && announcement !== card.announcement) this.io.announce(`${row.title}: ${announcement}`);
    card.announcement = announcement;
    card.source.textContent = row.url || '';
    card.detail.textContent = [row.errorDetail, choice.main && formatLabel(choice.main),
      ...choice.audio.map(id => formatLabel(row.result.formats.find(format => format.id === id))),
      ...row.jobs.map(job => job.path || job.error_detail || '')].filter(Boolean).join('\n');
    this.updateJobs(card, row, context);
  }
  updateJobs(card, row, context) {
    const ids = new Set(row.jobs.map(job => job.id));
    for (const [id, entry] of card.jobNodes) if (!ids.has(id)) { entry.root.remove(); card.jobNodes.delete(id); }
    for (const job of row.jobs) {
      let entry = card.jobNodes.get(job.id);
      if (!entry) {
        const root = node('div', 'media-job'), status = node('p', 'media-job-status'), progress = node('progress', '');
        const reason = node('p', 'media-job-reason'), format = node('p', 'media-job-reason'), action = node('button', 'text-button'); action.type = 'button'; progress.max = 1;
        root.append(status, format, progress, reason, action); card.jobs.append(root);
        entry = { root, status, progress, reason, format, action }; card.jobNodes.set(job.id, entry);
        action.onclick = async () => {
          if (entry.busy || entry.action.disabled) return;
          entry.busy = true; entry.action.disabled = true;
          try { await this.io.job(entry.command, entry.job, card.row.session); }
          catch (error) { this.io.error(error.message); }
          finally { entry.busy = false; this.updateJobs(card, card.row, card.context); }
        };
      }
      entry.job = job;
      const active = ACTIVE.has(job.status), done = job.status === 'done';
      entry.root.className = `media-job ${job.status}`;
      const percent = job.fraction == null ? null : Math.round(Math.max(0, Math.min(1, job.fraction)) * 100);
      entry.status.textContent = `${done ? '✓ ' : ''}${STATUS[job.status] || job.status}${job.status === 'running' && percent != null ? ` · ${percent}%` : ''}${done && job.file_exists === false ? ' · файл не найден' : ''}`;
      entry.reason.textContent = job.error || (active ? job.label || '' : ''); entry.reason.hidden = !entry.reason.textContent;
      entry.format.textContent = job.format_label || ''; entry.format.hidden = !entry.format.textContent;
      entry.progress.hidden = !active;
      entry.progress.setAttribute('aria-label', `Скачивание «${row.title}»`);
      if (job.fraction == null) entry.progress.removeAttribute('value'); else entry.progress.value = Math.max(0, Math.min(1, job.fraction));
      entry.command = done ? 'reveal' : active ? 'cancel' : 'retry';
      entry.action.textContent = done ? 'Показать файл' : active ? 'Отменить' : 'Повторить';
      entry.action.hidden = job.id === card.principal?.id || job.status === 'cancelling' || !done && !active && !['error', 'cancelled'].includes(job.status);
      entry.action.disabled = entry.busy || !context.online || done && (!job.path || job.file_exists === false) || Boolean(job.restored && !done);
    }
  }
  render(rows, context) {
    const keys = new Set(rows.map(row => row.key));
    for (const [key, card] of this.cards) if (!keys.has(key)) { card.root.remove(); this.cards.delete(key); }
    // Existing nodes retain their order, scroll position and focused controls.
    for (const row of rows) this.update(this.cards.get(row.key) || this.create(row.key), row, context);
    return rows.length;
  }
}
