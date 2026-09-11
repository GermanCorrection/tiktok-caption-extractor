/**
 * Cloudflare Turnstile Verification Helper
 * Verifies Turnstile tokens with Cloudflare's siteverify endpoint.
 */
export async function verifyTurnstileToken(
  token: string | undefined | null,
  clientIp: string,
  secretKey: string | undefined
): Promise<{ success: boolean; error?: string }> {
  // If no Turnstile secret is configured on the Worker, gracefully allow
  // (e.g. during CLI testing, automated checks, or development)
  if (!secretKey || secretKey.trim() === '' || secretKey === 'skip') {
    return { success: true };
  }

  if (!token || token.trim() === '') {
    return {
      success: false,
      error: 'Missing Cloudflare Turnstile verification token',
    };
  }

  // Cloudflare Always-Pass Test Token
  if (token === 'XXXX.DUMMY.TOKEN.XXXX') {
    return { success: true };
  }

  try {
    const formData = new FormData();
    formData.append('secret', secretKey.trim());
    formData.append('response', token.trim());
    if (clientIp && clientIp !== 'unknown-ip') {
      formData.append('remoteip', clientIp);
    }

    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body: formData,
      signal: AbortSignal.timeout(4000),
    });

    if (!response.ok) {
      return {
        success: false,
        error: `Turnstile verification endpoint error: HTTP ${response.status}`,
      };
    }

    const outcome = (await response.json()) as any;
    if (outcome.success) {
      return { success: true };
    }

    const errCodes = Array.isArray(outcome['error-codes'])
      ? outcome['error-codes'].join(', ')
      : 'Invalid Turnstile token';

    return {
      success: false,
      error: `Turnstile verification failed: ${errCodes}`,
    };
  } catch (err: any) {
    return {
      success: false,
      error: err?.message || 'Turnstile verification request timed out or failed',
    };
  }
}
