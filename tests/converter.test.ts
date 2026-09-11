import { describe, it, expect } from 'vitest';
import {
  formatSrtTimestamp,
  formatVttTimestamp,
  parseWebVTT,
  parseTikTokJsonSubtitles,
  convertToSrt,
  convertToVtt,
  convertToPlainText,
  cleanSubtitleText,
} from '../src/services/converter';

describe('Subtitle Converter', () => {
  it('formats SRT and VTT timestamps correctly', () => {
    // 0 ms
    expect(formatSrtTimestamp(0)).toBe('00:00:00,000');
    expect(formatVttTimestamp(0)).toBe('00:00:00.000');

    // 1500 ms -> 1.5s
    expect(formatSrtTimestamp(1500)).toBe('00:00:01,500');
    expect(formatVttTimestamp(1500)).toBe('00:00:01.500');

    // 65432 ms -> 1m 5s 432ms
    expect(formatSrtTimestamp(65432)).toBe('00:01:05,432');
    expect(formatVttTimestamp(65432)).toBe('00:01:05.432');

    // 3661005 ms -> 1h 1m 1s 5ms
    expect(formatSrtTimestamp(3661005)).toBe('01:01:01,005');
    expect(formatVttTimestamp(3661005)).toBe('01:01:01.005');
  });

  it('cleans HTML entities and special characters', () => {
    expect(cleanSubtitleText('Hello &quot;World&quot; &amp; friends&#39;')).toBe('Hello "World" & friends\'');
  });

  it('parses TikTok events JSON schema', () => {
    const rawEvents = {
      events: [
        { start_time: 200, end_time: 1400, text: 'Guten Tag!' },
        { start_time: 1500, end_time: 3200, text: 'Hier ist eine Erklärung.' },
      ],
    };

    const parsed = parseTikTokJsonSubtitles(rawEvents);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toEqual({ start: 200, end: 1400, text: 'Guten Tag!' });
    expect(parsed[1]).toEqual({ start: 1500, end: 3200, text: 'Hier ist eine Erklärung.' });
  });

  it('parses TikTok body schema with fractional seconds', () => {
    const rawBody = {
      body: [
        { from: 0.5, to: 2.1, content: 'Erster Satz' },
        { from: 2.2, to: 4.8, content: 'Zweiter Satz' },
      ],
    };

    const parsed = parseTikTokJsonSubtitles(rawBody);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].start).toBe(500);
    expect(parsed[0].end).toBe(2100);
    expect(parsed[0].text).toBe('Erster Satz');
  });

  it('parses raw WebVTT content', () => {
    const rawVtt = `WEBVTT

1
00:00:01.000 --> 00:00:03.500
Erste Zeile

2
00:00:03.800 --> 00:00:06.200
Zweite Zeile
`;

    const parsed = parseWebVTT(rawVtt);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].start).toBe(1000);
    expect(parsed[0].end).toBe(3500);
    expect(parsed[0].text).toBe('Erste Zeile');
    expect(parsed[1].start).toBe(3800);
    expect(parsed[1].end).toBe(6200);
    expect(parsed[1].text).toBe('Zweite Zeile');
  });

  it('generates valid SRT string', () => {
    const items = [
      { start: 1000, end: 3500, text: 'Hello World' },
      { start: 4000, end: 6000, text: 'Second line' },
    ];

    const srt = convertToSrt(items);
    expect(srt).toContain('1\n00:00:01,000 --> 00:00:03,500\nHello World');
    expect(srt).toContain('2\n00:00:04,000 --> 00:00:06,000\nSecond line');
  });

  it('generates valid WebVTT string', () => {
    const items = [
      { start: 1000, end: 3500, text: 'Hello World' },
    ];

    const vtt = convertToVtt(items);
    expect(vtt).toContain('WEBVTT');
    expect(vtt).toContain('00:00:01.000 --> 00:00:03.500\nHello World');
  });

  it('generates clean plain text without timestamps', () => {
    const items = [
      { start: 1000, end: 3500, text: 'First spoken phrase.' },
      { start: 4000, end: 6000, text: 'Second spoken phrase.' },
    ];

    const plainText = convertToPlainText(items);
    expect(plainText).toBe('First spoken phrase.\nSecond spoken phrase.');
    expect(plainText).not.toContain('-->');
    expect(plainText).not.toContain('00:00');
  });
});
