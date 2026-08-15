function timestamp(value) {
  const parts = value.trim().replace(',', '.').split(':').map(Number);
  if (parts.some((part) => !Number.isFinite(part)) || parts.length < 2 || parts.length > 3) return NaN;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] * 3600 + parts[1] * 60 + parts[2];
}

function plainText(value) {
  const namedEntities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return value
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\{[^}]*\}/g, '')
    .replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (entity, code) => {
      if (!code.startsWith('#')) return namedEntities[code.toLowerCase()] ?? entity;
      const numeric = code[1].toLowerCase() === 'x'
        ? Number.parseInt(code.slice(2), 16)
        : Number.parseInt(code.slice(1), 10);
      try {
        return String.fromCodePoint(numeric);
      } catch {
        return entity;
      }
    })
    .trim();
}

function parseBlockSubtitles(text) {
  const cues = [];
  const blocks = text.replace(/^\uFEFF/, '').replace(/\r/g, '').split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split('\n');
    const timingIndex = lines.findIndex((line) => line.includes('-->'));
    if (timingIndex < 0) continue;
    const match = lines[timingIndex].match(/^\s*([^\s]+)\s*-->\s*([^\s]+)/);
    if (!match) continue;
    const start = timestamp(match[1]);
    const end = timestamp(match[2]);
    const cueText = plainText(lines.slice(timingIndex + 1).join('\n'));
    if (Number.isFinite(start) && Number.isFinite(end) && end > start && cueText) {
      cues.push({ start, end, text: cueText });
    }
  }
  return cues;
}

function splitAssFields(value, count) {
  const fields = [];
  let rest = value;
  for (let index = 1; index < count; index++) {
    const comma = rest.indexOf(',');
    if (comma < 0) return [];
    fields.push(rest.slice(0, comma));
    rest = rest.slice(comma + 1);
  }
  fields.push(rest);
  return fields;
}

function parseAss(text) {
  const cues = [];
  let inEvents = false;
  let fields = [];
  for (const rawLine of text.replace(/^\uFEFF/, '').replace(/\r/g, '').split('\n')) {
    const line = rawLine.trim();
    if (/^\[events\]$/i.test(line)) {
      inEvents = true;
      continue;
    }
    if (line.startsWith('[')) {
      inEvents = false;
      continue;
    }
    if (!inEvents) continue;
    if (/^format\s*:/i.test(line)) {
      fields = line.slice(line.indexOf(':') + 1).split(',').map((field) => field.trim().toLowerCase());
      continue;
    }
    if (!/^dialogue\s*:/i.test(line) || !fields.length) continue;
    const values = splitAssFields(line.slice(line.indexOf(':') + 1).trim(), fields.length);
    const start = timestamp(values[fields.indexOf('start')] || '');
    const end = timestamp(values[fields.indexOf('end')] || '');
    const cueText = plainText((values[fields.indexOf('text')] || '')
      .replace(/\\[Nn]/g, '\n')
      .replace(/\\h/g, ' '));
    if (Number.isFinite(start) && Number.isFinite(end) && end > start && cueText) {
      cues.push({ start, end, text: cueText });
    }
  }
  return cues;
}

export function parseSubtitle(text, extension) {
  if (typeof text !== 'string') throw new Error('The subtitle file could not be read.');
  const kind = String(extension).toLowerCase();
  const cues = kind === 'ass' || kind === 'ssa' ? parseAss(text) : parseBlockSubtitles(text);
  cues.sort((a, b) => a.start - b.start || a.end - b.end);
  if (!cues.length) throw new Error('No readable subtitle cues were found in this file.');
  return cues;
}
