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
 * Resolves short links by following HTTP 301/302/307/308 redirects manually.
 * Returns the final URL and extracted Video ID.
 */
export async function resolveTikTokUrl(inputUrl: string): Promise<ResolveResult> {
  let currentUrl = inputUrl.trim();
  if (!currentUrl.startsWith('http://') && !currentUrl.startsWith('https://')) {
    currentUrl = `https://${currentUrl}`;
  }

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
      const nextUrl = new URL(location, currentUrl).toString();
      currentUrl = nextUrl;

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
