import { SubtitleItem } from '../types';

/**
 * Pads a number with leading zeros.
 */
function pad(num: number, digits: number): string {
  return num.toString().padStart(digits, '0');
}

/**
 * Formats milliseconds into SRT timestamp: HH:MM:SS,mmm
 */
export function formatSrtTimestamp(ms: number): string {
  const safeMs = Math.max(0, Math.floor(ms));
  const milliseconds = safeMs % 1000;
  const totalSeconds = Math.floor(safeMs / 1000);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);

  return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)},${pad(milliseconds, 3)}`;
}

/**
 * Formats milliseconds into WebVTT timestamp: HH:MM:SS.mmm
 */
export function formatVttTimestamp(ms: number): string {
  const safeMs = Math.max(0, Math.floor(ms));
  const milliseconds = safeMs % 1000;
  const totalSeconds = Math.floor(safeMs / 1000);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);

  return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)}.${pad(milliseconds, 3)}`;
}

/**
 * Basic HTML entity decoding and whitespace trimming.
 */
export function cleanSubtitleText(raw: string): string {
  return raw
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\r\n/g, '\n')
    .trim();
}

/**
 * Parses timestamps from WebVTT or SRT lines like "00:00:01.500 --> 00:00:04.200"
 */
function parseTimestampStringToMs(timeStr: string): number {
  const parts = timeStr.trim().split(':');
  if (parts.length < 2) return 0;

  let hours = 0;
  let minutes = 0;
  let secondsWithMs = '';

  if (parts.length === 3) {
    hours = parseInt(parts[0], 10) || 0;
    minutes = parseInt(parts[1], 10) || 0;
    secondsWithMs = parts[2];
  } else {
    minutes = parseInt(parts[0], 10) || 0;
    secondsWithMs = parts[1];
  }

  const [secStr, msStr = '0'] = secondsWithMs.split(/[.,]/);
  const seconds = parseInt(secStr, 10) || 0;
  const ms = parseInt(msStr.padEnd(3, '0').slice(0, 3), 10) || 0;

  return hours * 3600000 + minutes * 60000 + seconds * 1000 + ms;
}

/**
 * Parses raw WebVTT content into SubtitleItem array.
 */
export function parseWebVTT(vttText: string): SubtitleItem[] {
  const items: SubtitleItem[] = [];
  const lines = vttText.replace(/\r\n/g, '\n').split('\n');

  let currentStart = -1;
  let currentEnd = -1;
  let currentTextLines: string[] = [];

  const timeRegex = /((?:\d{2}:)?\d{2}:\d{2}[.,]\d{3})\s*-->\s*((?:\d{2}:)?\d{2}:\d{2}[.,]\d{3})/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Check for timestamp line
    const match = line.match(timeRegex);
    if (match) {
      if (currentStart >= 0 && currentTextLines.length > 0) {
        items.push({
          start: currentStart,
          end: currentEnd,
          text: cleanSubtitleText(currentTextLines.join('\n')),
        });
      }

      currentStart = parseTimestampStringToMs(match[1]);
      currentEnd = parseTimestampStringToMs(match[2]);
      currentTextLines = [];
      continue;
    }

    if (currentStart >= 0) {
      if (line === '') {
        if (currentTextLines.length > 0) {
          items.push({
            start: currentStart,
            end: currentEnd,
            text: cleanSubtitleText(currentTextLines.join('\n')),
          });
          currentStart = -1;
          currentEnd = -1;
          currentTextLines = [];
        }
      } else if (!line.startsWith('NOTE') && !line.startsWith('STYLE')) {
        currentTextLines.push(line);
      }
    }
  }

  // Push final item if any
  if (currentStart >= 0 && currentTextLines.length > 0) {
    items.push({
      start: currentStart,
      end: currentEnd,
      text: cleanSubtitleText(currentTextLines.join('\n')),
    });
  }

  return items;
}

/**
 * Parses TikTok JSON subtitles (supports multiple schema variations).
 */
export function parseTikTokJsonSubtitles(jsonContent: any): SubtitleItem[] {
  const items: SubtitleItem[] = [];

  let data = jsonContent;
  if (typeof jsonContent === 'string') {
    try {
      data = JSON.parse(jsonContent);
    } catch {
      return [];
    }
  }

  // Schema variation 1: { events: [ { start_time: 100, end_time: 1200, text: "..." } ] }
  if (Array.isArray(data?.events)) {
    for (const ev of data.events) {
      const text = cleanSubtitleText(ev.text || ev.caption || '');
      if (!text) continue;
      const start = Number(ev.start_time ?? ev.start ?? 0);
      const end = Number(ev.end_time ?? ev.end ?? start + 1000);
      items.push({ start, end, text });
    }
    return items;
  }

  // Schema variation 1b: { utterances: [ { start_time: 100, end_time: 1200, text: "..." } ] }
  if (Array.isArray(data?.utterances)) {
    for (const u of data.utterances) {
      const text = cleanSubtitleText(u.text || u.words || u.transcript || '');
      if (!text) continue;
      const start = Number(u.start_time ?? u.start ?? 0);
      const end = Number(u.end_time ?? u.end ?? start + 1000);
      items.push({ start, end, text });
    }
    return items;
  }

  // Schema variation 2: { body: [ { from: 0.5, to: 2.1, content: "..." } ] } (seconds or ms)
  if (Array.isArray(data?.body)) {
    for (const b of data.body) {
      const text = cleanSubtitleText(b.content || b.text || '');
      if (!text) continue;

      let from = Number(b.from ?? b.start ?? 0);
      let to = Number(b.to ?? b.end ?? from + 1);

      // Detect if timestamps are in fractional seconds instead of ms
      if (from < 10000 && to < 10000 && (from % 1 !== 0 || to % 1 !== 0 || to - from < 10)) {
        from = Math.round(from * 1000);
        to = Math.round(to * 1000);
      }

      items.push({ start: from, end: to, text });
    }
    return items;
  }

  // Schema variation 3: Direct array of items: [ { start: 100, end: 1200, text: "..." } ]
  if (Array.isArray(data)) {
    for (const item of data) {
      const text = cleanSubtitleText(item.text || item.content || '');
      if (!text) continue;
      let start = Number(item.start ?? item.from ?? item.start_time ?? 0);
      let end = Number(item.end ?? item.to ?? item.end_time ?? start + 1000);

      if (start < 10000 && end < 10000 && (start % 1 !== 0 || end % 1 !== 0 || end - start < 10)) {
        start = Math.round(start * 1000);
        end = Math.round(end * 1000);
      }

      items.push({ start, end, text });
    }
  }

  return items;
}

/**
 * Universal subtitle parser: detects WebVTT vs JSON and extracts subtitle items.
 */
export function parseRawSubtitles(raw: string): SubtitleItem[] {
  const trimmed = raw.trim();
  if (trimmed.startsWith('WEBVTT') || trimmed.includes('-->')) {
    return parseWebVTT(trimmed);
  }

  try {
    const json = JSON.parse(trimmed);
    return parseTikTokJsonSubtitles(json);
  } catch {
    // If not valid JSON, try VTT parser as fallback
    return parseWebVTT(trimmed);
  }
}

/**
 * Converts SubtitleItems into a valid SRT file string.
 */
export function convertToSrt(items: SubtitleItem[]): string {
  if (!items || items.length === 0) return '';

  return items
    .filter((item) => item.text.length > 0)
    .map((item, index) => {
      const seq = index + 1;
      const start = formatSrtTimestamp(item.start);
      const end = formatSrtTimestamp(item.end);
      return `${seq}\n${start} --> ${end}\n${item.text}\n`;
    })
    .join('\n');
}

/**
 * Converts SubtitleItems into a valid WebVTT file string.
 */
export function convertToVtt(items: SubtitleItem[]): string {
  if (!items || items.length === 0) return 'WEBVTT\n';

  const body = items
    .filter((item) => item.text.length > 0)
    .map((item, index) => {
      const seq = index + 1;
      const start = formatVttTimestamp(item.start);
      const end = formatVttTimestamp(item.end);
      return `${seq}\n${start} --> ${end}\n${item.text}\n`;
    })
    .join('\n');

  return `WEBVTT\n\n${body}`;
}

/**
 * Converts SubtitleItems into a clean plain-text transcript (without timestamps or sequence numbers).
 */
export function convertToPlainText(items: SubtitleItem[]): string {
  if (!items || items.length === 0) return '';

  return items
    .map((item) => item.text.trim())
    .filter((text) => text.length > 0)
    .join('\n');
}

