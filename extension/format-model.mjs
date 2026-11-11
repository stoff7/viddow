export function formatLabel(format) {
  const pieces = [format.height ? `${format.height}p` : format.kind === 'audio' ? 'Звук' : 'Разрешение неизвестно'];
  if (format.fps) pieces.push(`${format.fps} fps`);
  if (format.language) pieces.push(format.language);
  if (format.ext) pieces.push(format.ext);
  if (format.kind === 'video') pieces.push('без звука');
  if (format.kind === 'combined') pieces.push('со звуком');
  if (format.kind === 'unknown') pieces.push('состав дорожек неизвестен');
  if (format.format_note) pieces.push(format.format_note);
  pieces.push(`ID ${format.id}`);
  return pieces.join(' · ');
}

export function mainFormats(formats) {
  const video = formats.filter(format => format.kind !== 'audio');
  return (video.length ? video : formats).slice().sort((a, b) =>
    (b.height || 0) - (a.height || 0) || (b.fps || 0) - (a.fps || 0) || (b.tbr || 0) - (a.tbr || 0));
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
