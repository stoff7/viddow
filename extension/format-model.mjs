// RFC 6381 AVC sample entries and ffprobe names describe the same codec family.
export function videoCodecFamily(value) {
  const codec = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return /^(?:h\.?264|avc|avc[13](?:\.[0-9a-f]{6})?)$/.test(codec) ? 'h264' : codec;
}
export const positiveRate = value => Number.isFinite(value) && value > 0 ? value : null;
export const bitrate = format => positiveRate(format.kind === 'audio' ? format.abr : format.vbr)
  || (format.kind !== 'combined' ? positiveRate(format.tbr) : null);
export function bitrateLabel(format) {
  const rate = bitrate(format), total = !rate && positiveRate(format.tbr);
  const value = rate || total;
  return value ? `${new Intl.NumberFormat('ru', { maximumFractionDigits: value >= 1000 ? 2 : 0 }).format(value >= 1000 ? value / 1000 : value)} ${value >= 1000 ? 'Мбит/с' : 'кбит/с'}${total ? ' всего' : ''}` : 'битрейт не указан';
}
export function preferredAudio(formats) {
  const audio = formats.filter(format => format.kind === 'audio');
  if (audio.length <= 1) return audio;
  if (!audio[0].audio_group || !audio.every(row => row.audio_group === audio[0].audio_group)) return [];
  return [audio.reduce((best, row) => (bitrate(row) || 0) > (bitrate(best) || 0) ? row : best)];
}
export const validFps = value => Number.isFinite(value) && value > 0 && value <= 240 ? value : null;
export function formatLabel(format) {
  const pieces = [format.height ? `${format.height}p` : format.kind === 'audio' ? 'Звук' : 'Разрешение неизвестно'];
  if (validFps(format.fps)) pieces.push(`${validFps(format.fps)} fps`);
  if (format.language) pieces.push(format.language);
  if (format.ext) pieces.push(format.ext);
  if (format.kind === 'video') pieces.push('без звука');
  if (format.kind === 'combined') pieces.push('со звуком');
  if (format.kind === 'unknown') pieces.push('состав дорожек неизвестен');
  if (format.format_note) pieces.push(format.format_note);
  pieces.push(bitrateLabel(format));
  pieces.push(`ID ${format.id}`);
  return pieces.join(' · ');
}

export function mainFormats(formats) {
  const video = formats.filter(format => format.kind !== 'audio');
  const rows = video.length ? video : formats;
  const codecs = [...new Set(rows.map(row => videoCodecFamily(row.vcodec)))];
  return rows.slice().sort((a, b) =>
    (b.height || 0) - (a.height || 0) || (validFps(b.fps) || 0) - (validFps(a.fps) || 0) || codecs.indexOf(videoCodecFamily(a.vcodec)) - codecs.indexOf(videoCodecFamily(b.vcodec)) || (bitrate(b) || 0) - (bitrate(a) || 0));
}

export function qualityLabel(format) {
  const quality = format.kind === 'audio' ? 'Только звук' : format.height ? `${format.height}p` : 'Качество неизвестно';
  return [quality, validFps(format.fps) ? `${validFps(format.fps)} fps` : '', format.vcodec && format.vcodec !== 'none' ? format.vcodec : '', bitrateLabel(format), format.ext,
    format.kind === 'combined' ? 'со звуком' : format.kind === 'unknown' ? 'звук неизвестен' : ''].filter(Boolean).join(' · ');
}

export function audioLabel(format) {
  let language = format.language || 'Язык не указан';
  try { if (format.language) language = new Intl.DisplayNames(['ru'], { type: 'language' }).of(format.language); } catch { /* Keep source language. */ }
  return [language, format.acodec && format.acodec !== 'none' ? format.acodec : '', bitrateLabel(format), format.audio_channels ? `${format.audio_channels} кан.` : '', format.format_note, format.ext].filter(Boolean).join(' · ');
}

// A single known audio track is unambiguous; multiple languages require a choice.
export function defaultChoice(formats, ffmpeg) {
  const ordered = mainFormats(formats);
  const audio = preferredAudio(formats);
  const main = ordered.find(format => format.kind === 'combined' || format.kind === 'audio'
    || (format.kind === 'video' && ffmpeg && audio.length === 1)) || ordered[0];
  return { main: main?.id || '', audio: main?.kind === 'video' && ffmpeg && audio.length === 1 ? [audio[0].id] : [] };
}

export function choiceProblem(main, audioIds, ffmpeg, silent = false) {
  if (!main) return 'Выберите формат.';
  if (main.kind === 'video' && !audioIds.length && !silent) return 'Выберите хотя бы одну звуковую дорожку или «Видео без звука».';
  if (audioIds.length && !ffmpeg) return 'Для объединения видео и звука нужен ffmpeg: brew install ffmpeg';
  if (audioIds.length && main.kind !== 'video') return 'Отдельный звук доступен только для видео без встроенного звука.';
  return '';
}

export function durationLabel(result) {
  if (result.is_live) return 'Прямой эфир · длительность неизвестна';
  if (result.duration == null) return 'Длительность неизвестна';
  const seconds = Math.floor(result.duration);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
