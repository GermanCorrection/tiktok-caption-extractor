// TikTok URL Resolver and Video ID Extractor

export interface ResolveResult {
  videoId: string;
  resolvedUrl: string;
}

const TIKTOK_VIDEO_REGEX = /(?:video|photo|v)\/([0-9]{15,24})/i;
const TIKTOK_QUERY_PARAM_REGEX = /[?&](?:item_id|video_id)=([0-9]{15,24})/i;

const MOBILE_USER_AGENT =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

/**
 * Extracts a numeric TikTok Video ID from a URL string.
 */
export function extractVideoId(urlStr: string): string | null {
  try {
    const matchPath = urlStr.match(TIKTOK_VIDEO_REGEX);
    if (matchPath && matchPath[1]) {
      return matchPath[1];
    }

    const matchQuery = urlStr.match(TIKTOK_QUERY_PARAM_REGEX);
    if (matchQuery && matchQuery[1]) {
      return matchQuery[1];
    }
  } catch (err) {
    console.error('Error matching video ID:', err);
  }
  return null;
}

/**
 * Checks whether a URL is a known TikTok short link or needs resolution.
 */
export function isShortLink(urlStr: string): boolean {
  try {
    const parsed = new URL(urlStr);
    const host = parsed.hostname.toLowerCase();
    return (
      host === 'vm.tiktok.com' ||
      host === 'vt.tiktok.com' ||
      host === 'v.tiktok.com' ||
      (host.endsWith('.tiktok.com') && (parsed.pathname.startsWith('/t/') || parsed.pathname.startsWith('/v/')))
    );
  } catch {
    return false;
  }
}

/**
 * Checks if a hostname belongs to private/internal IPs or localhost.
 */
export function isPrivateOrBlockedHost(hostname: string): boolean {
  if (!hostname) return true;

  // Localhost & internal names
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname === 'local' ||
    hostname.endsWith('.local') ||
    hostname === 'internal' ||
    hostname.endsWith('.internal')
  ) {
    return true;
  }

  // IPv4 Loopback: 127.0.0.0/8
  if (/^127(?:\.[0-9]+){3}$/.test(hostname)) return true;
  // IPv4 Private Class A: 10.0.0.0/8
  if (/^10(?:\.[0-9]+){3}$/.test(hostname)) return true;
  // IPv4 Private Class B: 172.16.0.0/12
  if (/^172\.(?:1[6-9]|2[0-9]|3[01])(?:\.[0-9]+){2}$/.test(hostname)) return true;
  // IPv4 Private Class C: 192.168.0.0/16
  if (/^192\.168(?:\.[0-9]+){2}$/.test(hostname)) return true;
  // IPv4 Link-Local & Cloud Metadata: 169.254.0.0/16 (e.g. 169.254.169.254)
  if (/^169\.254(?:\.[0-9]+){2}$/.test(hostname)) return true;
  // IPv4 Current Network: 0.0.0.0/8
  if (/^0(?:\.[0-9]+){3}$/.test(hostname)) return true;
  // Numeric/Decimal or Hex representations of IP
  if (/^(?:0x[0-9a-f]+|[0-9]+)$/i.test(hostname)) return true;

  // IPv6 loopback, link-local, unique local
  if (
    hostname === '::1' ||
    hostname === '[::1]' ||
    hostname === '::' ||
    hostname === '[::]' ||
    hostname.startsWith('fe80:') ||
    hostname.startsWith('[fe80:') ||
    hostname.startsWith('fc00:') ||
    hostname.startsWith('[fc00:') ||
    hostname.startsWith('fd00:') ||
    hostname.startsWith('[fd00:')
  ) {
    return true;
  }

  return false;
}

/**
 * Checks whether a hostname strictly belongs to the official TikTok domain family.
 */
export function isWhitelistedTikTokDomain(hostname: string): boolean {
  if (!hostname) return false;
  const h = hostname.toLowerCase().trim();

  // Known exact domain entries
  const exact = [
    'tiktok.com',
    'www.tiktok.com',
    'vm.tiktok.com',
    'vt.tiktok.com',
    'v.tiktok.com',
    'm.tiktok.com',
  ];
  if (exact.includes(h)) return true;

  // Valid TikTok subdomains (e.g. de.tiktok.com, us.tiktok.com)
  if (h.endsWith('.tiktok.com')) {
    const prefix = h.slice(0, -'.tiktok.com'.length);
    return /^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(prefix);
  }

  return false;
}

/**
 * Strict TikTok domain and SSRF validation.
 * Rejects non-HTTPS schemes, private/internal IPs, and non-TikTok hosts.
 */
export function validateTikTokUrl(urlStr: string): {
  valid: boolean;
  error?: string;
  normalizedUrl?: string;
} {
  if (!urlStr || typeof urlStr !== 'string') {
    return { valid: false, error: 'URL must be a non-empty string' };
  }

  let raw = urlStr.trim();
  // Auto-prefix https if user omitted scheme (e.g. "vm.tiktok.com/...")
  if (!/^https?:\/\//i.test(raw)) {
    raw = `https://${raw}`;
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { valid: false, error: 'Invalid URL format' };
  }

  // 1. Strict HTTPS Protocol
  if (parsed.protocol.toLowerCase() !== 'https:') {
    return { valid: false, error: 'Insecure protocol: Only HTTPS URLs are allowed' };
  }

  // 2. Reject credentials in URL (e.g. https://user:pass@attacker.com)
  if (parsed.username || parsed.password) {
    return { valid: false, error: 'Embedded credentials in URL are prohibited' };
  }

  const hostname = parsed.hostname.toLowerCase();

  // 3. Block private and internal IPs / localhost (SSRF protection)
  if (isPrivateOrBlockedHost(hostname)) {
    return { valid: false, error: 'Access to private or internal network addresses is blocked' };
  }

  // 4. Whitelist TikTok domains
  if (!isWhitelistedTikTokDomain(hostname)) {
    return {
      valid: false,
      error: `Unauthorized domain: "${hostname}". Only official TikTok URLs (*.tiktok.com) are supported.`,
    };
  }

  return { valid: true, normalizedUrl: parsed.toString() };
}

/**
 * Resolves short links by following HTTP 301/302/307/308 redirects manually.
 * Returns the final URL and extracted Video ID.
 */
export async function resolveTikTokUrl(inputUrl: string): Promise<ResolveResult> {
  const check = validateTikTokUrl(inputUrl);
  if (!check.valid || !check.normalizedUrl) {
    throw new Error(`invalid_link: ${check.error || 'Invalid TikTok URL'}`);
  }

  let currentUrl = check.normalizedUrl;

  // First quick check: maybe it is already a direct video link
  let videoId = extractVideoId(currentUrl);
  if (videoId && !isShortLink(currentUrl)) {
    return { videoId, resolvedUrl: currentUrl };
  }

  let hops = 0;
  const maxHops = 6;

  while (hops < maxHops) {
    hops++;

    const response = await fetch(currentUrl, {
      method: 'GET',
      redirect: 'manual',
      headers: {
        'User-Agent': MOBILE_USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7',
      },
    });

    const status = response.status;
    const location = response.headers.get('location');

    if (location && [301, 302, 303, 307, 308].includes(status)) {
      const nextParsed = new URL(location, currentUrl);
      const redirectCheck = validateTikTokUrl(nextParsed.toString());
      if (!redirectCheck.valid || !redirectCheck.normalizedUrl) {
        throw new Error(
          `ssrf_blocked: Redirect to unauthorized host or protocol blocked: ${nextParsed.hostname}`
        );
      }

      currentUrl = redirectCheck.normalizedUrl;

      // Check if location header already has the video ID
      videoId = extractVideoId(currentUrl);
      if (videoId) {
        return { videoId, resolvedUrl: currentUrl };
      }
      continue;
    }

    // If we received 200 OK without redirect, check if current URL has it
    videoId = extractVideoId(currentUrl);
    if (videoId) {
      return { videoId, resolvedUrl: currentUrl };
    }

    // Fallback: check if the HTML body contains canonical URL or canonical link tag
    try {
      const text = await response.text();
      const canonicalMatch = text.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i);
      if (canonicalMatch && canonicalMatch[1]) {
        const canonicalUrl = canonicalMatch[1];
        const canonicalId = extractVideoId(canonicalUrl);
        if (canonicalId) {
          return { videoId: canonicalId, resolvedUrl: canonicalUrl };
        }
      }

      // Check inside JSON rehydration or og:url meta tags
      const ogUrlMatch = text.match(/<meta[^>]+property=["']og:url["'][^>]+content=["']([^"']+)["']/i);
      if (ogUrlMatch && ogUrlMatch[1]) {
        const ogId = extractVideoId(ogUrlMatch[1]);
        if (ogId) {
          return { videoId: ogId, resolvedUrl: ogUrlMatch[1] };
        }
      }
    } catch {
      // Ignored
    }

    break;
  }

  if (!videoId) {
    throw new Error('invalid_link: Could not extract TikTok Video ID from URL');
  }

  return { videoId, resolvedUrl: currentUrl };
}
