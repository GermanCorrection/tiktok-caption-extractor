import { describe, it, expect } from 'vitest';
import { validateTikTokUrl, isPrivateOrBlockedHost, isWhitelistedTikTokDomain } from '../src/services/resolver';
import { app } from '../src/index';

describe('Security: SSRF & Input Validation', () => {
  describe('Private / Reserved IP & Hostname Blocker', () => {
    it('blocks localhost variants', () => {
      expect(isPrivateOrBlockedHost('localhost')).toBe(true);
      expect(isPrivateOrBlockedHost('sub.localhost')).toBe(true);
      expect(isPrivateOrBlockedHost('local')).toBe(true);
      expect(isPrivateOrBlockedHost('internal')).toBe(true);
    });

    it('blocks IPv4 loopback (127.0.0.0/8)', () => {
      expect(isPrivateOrBlockedHost('127.0.0.1')).toBe(true);
      expect(isPrivateOrBlockedHost('127.0.0.2')).toBe(true);
      expect(isPrivateOrBlockedHost('127.255.255.254')).toBe(true);
    });

    it('blocks IPv4 private Class A, B, C ranges', () => {
      expect(isPrivateOrBlockedHost('10.0.0.1')).toBe(true);
      expect(isPrivateOrBlockedHost('10.254.0.1')).toBe(true);
      expect(isPrivateOrBlockedHost('172.16.0.1')).toBe(true);
      expect(isPrivateOrBlockedHost('172.31.255.255')).toBe(true);
      expect(isPrivateOrBlockedHost('192.168.0.1')).toBe(true);
      expect(isPrivateOrBlockedHost('192.168.1.254')).toBe(true);
    });

    it('blocks Cloud Metadata / Link-Local (169.254.0.0/16)', () => {
      expect(isPrivateOrBlockedHost('169.254.169.254')).toBe(true);
      expect(isPrivateOrBlockedHost('169.254.1.1')).toBe(true);
    });

    it('blocks decimal and hex encoded IP formats', () => {
      expect(isPrivateOrBlockedHost('2130706433')).toBe(true); // 127.0.0.1
      expect(isPrivateOrBlockedHost('0x7f000001')).toBe(true); // 127.0.0.1
    });

    it('blocks IPv6 loopback and private ranges', () => {
      expect(isPrivateOrBlockedHost('::1')).toBe(true);
      expect(isPrivateOrBlockedHost('[::1]')).toBe(true);
      expect(isPrivateOrBlockedHost('fe80::1')).toBe(true);
      expect(isPrivateOrBlockedHost('fc00::1')).toBe(true);
    });

    it('allows legitimate public hostnames', () => {
      expect(isPrivateOrBlockedHost('tiktok.com')).toBe(false);
      expect(isPrivateOrBlockedHost('www.tiktok.com')).toBe(false);
      expect(isPrivateOrBlockedHost('vm.tiktok.com')).toBe(false);
    });
  });

  describe('TikTok Domain Whitelisting', () => {
    it('accepts official TikTok domain variants', () => {
      expect(isWhitelistedTikTokDomain('tiktok.com')).toBe(true);
      expect(isWhitelistedTikTokDomain('www.tiktok.com')).toBe(true);
      expect(isWhitelistedTikTokDomain('vm.tiktok.com')).toBe(true);
      expect(isWhitelistedTikTokDomain('vt.tiktok.com')).toBe(true);
      expect(isWhitelistedTikTokDomain('v.tiktok.com')).toBe(true);
      expect(isWhitelistedTikTokDomain('m.tiktok.com')).toBe(true);
      expect(isWhitelistedTikTokDomain('de.tiktok.com')).toBe(true);
    });

    it('rejects lookalike, spoofed, or subdomained attacker domains', () => {
      expect(isWhitelistedTikTokDomain('evil-tiktok.com')).toBe(false);
      expect(isWhitelistedTikTokDomain('tiktok.com.evil.com')).toBe(false);
      expect(isWhitelistedTikTokDomain('faketiktok.com')).toBe(false);
      expect(isWhitelistedTikTokDomain('attacker.com')).toBe(false);
      expect(isWhitelistedTikTokDomain('google.com')).toBe(false);
      expect(isWhitelistedTikTokDomain('notktok.com')).toBe(false);
    });
  });

  describe('validateTikTokUrl Full Pipeline', () => {
    it('accepts clean HTTPS TikTok URLs', () => {
      const result = validateTikTokUrl('https://www.tiktok.com/@user/video/7391234567890123456');
      expect(result.valid).toBe(true);
      expect(result.normalizedUrl).toBe('https://www.tiktok.com/@user/video/7391234567890123456');
    });

    it('auto-prepends https if omitted', () => {
      const result = validateTikTokUrl('vm.tiktok.com/ZGeXXXXX/');
      expect(result.valid).toBe(true);
      expect(result.normalizedUrl).toBe('https://vm.tiktok.com/ZGeXXXXX/');
    });

    it('rejects insecure HTTP scheme', () => {
      const result = validateTikTokUrl('http://www.tiktok.com/@user/video/7391234567890123456');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Only HTTPS');
    });

    it('rejects embedded credentials', () => {
      const result = validateTikTokUrl('https://admin:pass@www.tiktok.com/video/123');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('credentials');
    });

    it('rejects SSRF payloads', () => {
      const r1 = validateTikTokUrl('https://127.0.0.1/video/123');
      expect(r1.valid).toBe(false);

      const r2 = validateTikTokUrl('https://169.254.169.254/latest/meta-data/');
      expect(r2.valid).toBe(false);

      const r3 = validateTikTokUrl('https://localhost:8080/admin');
      expect(r3.valid).toBe(false);
    });

    it('rejects non-TikTok foreign domains', () => {
      const result = validateTikTokUrl('https://example.com/exploit');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Unauthorized domain');
    });
  });

  describe('API Endpoints SSRF Enforcement', () => {
    it('rejects non-TikTok URLs on GET /api/v1/subtitles with 400 Bad Request', async () => {
      const req = new Request('http://localhost/api/v1/subtitles?url=https://attacker.com/malicious', {
        headers: { 'cf-connecting-ip': '1.2.3.4' },
      });

      const res = await app.fetch(req, {
        KV_CACHE: {
          get: async () => null,
          put: async () => {},
        } as any,
      } as any);

      expect(res.status).toBe(400);
      const data: any = await res.json();
      expect(data.error).toContain('Invalid TikTok URL');
    });

    it('rejects private IP URLs on GET /api/v1/subtitles with 400 Bad Request', async () => {
      const req = new Request('http://localhost/api/v1/subtitles?url=http://127.0.0.1/etc/passwd', {
        headers: { 'cf-connecting-ip': '1.2.3.4' },
      });

      const res = await app.fetch(req, {
        KV_CACHE: {
          get: async () => null,
          put: async () => {},
        } as any,
      } as any);

      expect(res.status).toBe(400);
    });
  });
});
