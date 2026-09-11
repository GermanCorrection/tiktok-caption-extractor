// Client-side Controller for TikTok Caption & Subtitle Downloader

document.addEventListener('DOMContentLoaded', () => {
  const API_BASE = window.location.hostname.includes('workers.dev') || window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
    ? ''
    : 'https://captionfast.vitobuchholzx.workers.dev';

  const form = document.getElementById('submit-form');
  const urlInput = document.getElementById('tiktok-url-input');
  const pasteBtn = document.getElementById('paste-btn');
  const submitBtn = document.getElementById('submit-btn');
  const submitSpinner = document.getElementById('submit-spinner');
  const btnText = submitBtn.querySelector('.btn-text');

  const statusCard = document.getElementById('status-card');
  const statusBadge = document.getElementById('status-badge');
  const statusIcon = document.getElementById('status-icon');
  const statusText = document.getElementById('status-text');
  const statusMessage = document.getElementById('status-message');
  const progressBar = document.getElementById('progress-bar');
  const jobIdDisplay = document.getElementById('job-id-display');

  const resultSection = document.getElementById('result-section');
  const resultLang = document.getElementById('result-lang');
  const resultCount = document.getElementById('result-count');
  const resultCached = document.getElementById('result-cached');
  const downloadSrtBtn = document.getElementById('download-srt-btn');
  const downloadVttBtn = document.getElementById('download-vtt-btn');
  const downloadTxtBtn = document.getElementById('download-txt-btn');

  const langSelectorContainer = document.getElementById('language-selector-container');
  const langSelect = document.getElementById('language-select');

  const transcriptBody = document.getElementById('transcript-body');
  const copyTranscriptBtn = document.getElementById('copy-transcript-btn');
  const copyBtnText = document.getElementById('copy-btn-text');

  const errorSection = document.getElementById('error-section');
  const errorText = document.getElementById('error-text');

  let pollInterval = null;
  let currentTranscriptText = '';
  let availableLanguages = [];

  // Lazy Load Cloudflare Turnstile to prevent blocking initial render & LCP
  let turnstileLoaded = false;
  let turnstileWidgetId = null;

  window.onloadTurnstileCallback = function () {
    const widgetEl = document.getElementById('turnstile-widget');
    if (widgetEl && window.turnstile && turnstileWidgetId === null) {
      try {
        turnstileWidgetId = window.turnstile.render(widgetEl, {
          sitekey: widgetEl.getAttribute('data-sitekey') || '0x4AAAAAAEwmDeb28xKk3gw6',
          theme: 'dark',
        });
      } catch (e) {
        console.warn('Turnstile render error:', e);
      }
    }
  };

  function loadTurnstile() {
    if (turnstileLoaded) return;
    turnstileLoaded = true;

    const script = document.createElement('script');
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?onload=onloadTurnstileCallback';
    script.async = true;
    script.defer = true;
    document.head.appendChild(script);
  }

  // Trigger Turnstile on first user intent
  if (urlInput) {
    urlInput.addEventListener('focus', loadTurnstile, { once: true });
    urlInput.addEventListener('click', loadTurnstile, { once: true });
    urlInput.addEventListener('input', loadTurnstile, { once: true });
  }
  if (pasteBtn) {
    pasteBtn.addEventListener('click', loadTurnstile, { once: true });
  }
  ['touchstart', 'mousedown', 'keydown'].forEach((evt) => {
    window.addEventListener(evt, loadTurnstile, { once: true, passive: true });
  });
  // Idle fallback after page has settled (avoiding initial audit window)
  if ('requestIdleCallback' in window) {
    window.requestIdleCallback(() => setTimeout(loadTurnstile, 4000));
  } else {
    setTimeout(loadTurnstile, 4000);
  }

  // International Status Configuration
  const STATUS_CONFIG = {
    queued: {
      text: 'In Queue',
      icon: '⏳',
      badgeClass: 'queued',
      barClass: 'queued',
      message: 'Processing in serverless queue with Cloudflare Browser Rendering...',
    },
    processing: {
      text: 'Extracting...',
      icon: '⚙️',
      badgeClass: 'processing',
      barClass: 'processing',
      message: 'Analyzing TikTok video stream and extracting spoken captions...',
    },
    done: {
      text: 'Ready',
      icon: '✅',
      badgeClass: 'done',
      barClass: 'done',
      message: 'Captions successfully extracted and converted. Ready for download!',
    },
    no_subtitles_available: {
      text: 'No Captions Found',
      icon: '⚠️',
      badgeClass: 'no_subtitles_available',
      barClass: 'error',
      message: 'This video does not have spoken captions, closed captions, or automatic subtitles.',
    },
    video_private_or_deleted: {
      text: 'Video Unavailable',
      icon: '🔒',
      badgeClass: 'video_private_or_deleted',
      barClass: 'error',
      message: 'This video is private, removed, or geo-restricted.',
    },
    failed_blocked: {
      text: 'Access Blocked',
      icon: '🛡️',
      badgeClass: 'failed_blocked',
      barClass: 'error',
      message: 'TikTok requested a security challenge for this video request.',
    },
    invalid_link: {
      text: 'Invalid Link',
      icon: '❌',
      badgeClass: 'invalid_link',
      barClass: 'error',
      message: 'Could not extract a valid TikTok video ID from the provided link.',
    },
    error: {
      text: 'Extraction Failed',
      icon: '❌',
      badgeClass: 'error',
      barClass: 'error',
      message: 'An unexpected error occurred while processing this video.',
    },
  };

  // 1-Click Paste functionality
  if (pasteBtn) {
    pasteBtn.addEventListener('click', async () => {
      try {
        const text = await navigator.clipboard.readText();
        if (text) {
          urlInput.value = text.trim();
          urlInput.focus();
        }
      } catch (err) {
        console.warn('Clipboard read not permitted:', err);
        urlInput.focus();
      }
    });
  }

  function setSubmittingState(loading) {
    submitBtn.disabled = loading;
    if (loading) {
      submitSpinner.classList.remove('hidden');
      btnText.textContent = 'Extracting...';
    } else {
      submitSpinner.classList.add('hidden');
      btnText.textContent = 'Get Subtitles →';
    }
  }

  function getTierBadgeLabel(tier, cached) {
    if (cached) return '⚡ Instant (Cache)';
    if (tier === 'tier1_fast') return '⚡ Fast Extract (<350ms)';
    if (tier === 'tier2_mirror') return '🚀 Mirror Extract (<450ms)';
    if (tier === 'tier3_browser') return '🌐 Browser Engine';
    return '⚡ Fresh Extract';
  }

  function renderTranscript(subtitles, rawTranscript) {
    if (rawTranscript) {
      currentTranscriptText = rawTranscript;
    } else if (Array.isArray(subtitles) && subtitles.length > 0) {
      currentTranscriptText = subtitles.map((s) => s.text).filter(Boolean).join('\n');
    } else {
      currentTranscriptText = '';
    }

    if (!transcriptBody) return;

    if (Array.isArray(subtitles) && subtitles.length > 0) {
      transcriptBody.innerHTML = subtitles
        .filter((s) => s.text && s.text.trim())
        .map((s) => `<p class="transcript-line"><span class="transcript-time">[${formatDisplayTime(s.start)}]</span> ${escapeHtml(s.text)}</p>`)
        .join('');
    } else if (currentTranscriptText) {
      transcriptBody.innerHTML = `<p class="transcript-plain">${escapeHtml(currentTranscriptText)}</p>`;
    } else {
      transcriptBody.innerHTML = '<p class="transcript-placeholder">Transcript text preview not available.</p>';
    }
  }

  function formatDisplayTime(ms) {
    const totalSec = Math.floor((ms || 0) / 1000);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  function updateStatusUI(status, details = {}) {
    const config = STATUS_CONFIG[status] || STATUS_CONFIG.error;

    statusBadge.className = `status-badge ${config.badgeClass}`;
    statusIcon.textContent = config.icon;
    statusText.textContent = config.text;
    progressBar.className = `progress-bar ${config.barClass}`;
    statusMessage.textContent = details.message || config.message;

    if (details.jobId) {
      jobIdDisplay.textContent = `Job: ${details.jobId.slice(0, 8)}...`;
    }

    if (status === 'done') {
      resultSection.classList.remove('hidden');
      errorSection.classList.add('hidden');

      resultLang.textContent = (details.language || 'Original').toUpperCase();
      resultCount.textContent = details.captionCount ? `${details.captionCount} Segments` : 'Available';
      resultCached.textContent = getTierBadgeLabel(details.tier, details.cached);

      if (downloadSrtBtn) downloadSrtBtn.href = `/api/download/${details.jobId}/srt`;
      if (downloadVttBtn) downloadVttBtn.href = `/api/download/${details.jobId}/vtt`;
      if (downloadTxtBtn) downloadTxtBtn.href = `/api/download/${details.jobId}/txt`;

      renderTranscript(details.subtitles, details.transcript);

      // Multi-Language Dropdown
      availableLanguages = details.languages || [];
      if (langSelectorContainer && langSelect) {
        if (availableLanguages.length > 1) {
          langSelectorContainer.classList.remove('hidden');
          langSelect.innerHTML = availableLanguages
            .map(
              (l) =>
                `<option value="${escapeHtml(l.url || l.code)}"${
                  l.code === details.language ? ' selected' : ''
                }>${escapeHtml(l.name || l.code)}${l.isOriginal ? ' (Original)' : ''}</option>`
            )
            .join('');
        } else {
          langSelectorContainer.classList.add('hidden');
        }
      }
    } else if (
      status === 'no_subtitles_available' ||
      status === 'video_private_or_deleted' ||
      status === 'failed_blocked' ||
      status === 'invalid_link' ||
      status === 'error'
    ) {
      resultSection.classList.add('hidden');
      errorSection.classList.remove('hidden');
      errorText.textContent = details.errorMessage || config.message;
    } else {
      resultSection.classList.add('hidden');
      errorSection.classList.add('hidden');
    }
  }

  // Language switch handler
  if (langSelect) {
    langSelect.addEventListener('change', async () => {
      const selectedValue = langSelect.value;
      const selectedObj = availableLanguages.find((l) => (l.url || l.code) === selectedValue);
      if (!selectedObj || !selectedObj.url) return;

      try {
        const res = await fetch(`${API_BASE}/api/convert-subtitle`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: selectedObj.url }),
        });
        if (!res.ok) return;

        const data = await res.json();
        if (data.success) {
          resultLang.textContent = (selectedObj.code || selectedObj.name).toUpperCase();
          resultCount.textContent = `${data.captionCount || data.subtitles?.length || 0} Segments`;
          renderTranscript(data.subtitles, data.transcript);
        }
      } catch (err) {
        console.warn('Failed to switch subtitle language:', err);
      }
    });
  }

  // Copy Transcript button
  if (copyTranscriptBtn) {
    copyTranscriptBtn.addEventListener('click', async () => {
      if (!currentTranscriptText) return;
      try {
        await navigator.clipboard.writeText(currentTranscriptText);
        copyTranscriptBtn.classList.add('copied');
        if (copyBtnText) copyBtnText.textContent = '✅ Copied!';
        setTimeout(() => {
          copyTranscriptBtn.classList.remove('copied');
          if (copyBtnText) copyBtnText.textContent = 'Copy Transcript';
        }, 2000);
      } catch (err) {
        console.warn('Clipboard write error:', err);
      }
    });
  }

  async function pollJobStatus(jobId) {
    if (pollInterval) clearInterval(pollInterval);

    pollInterval = setInterval(async () => {
      try {
        const response = await fetch(`${API_BASE}/api/status/${jobId}`);
        if (!response.ok) return;

        const data = await response.json();
        updateStatusUI(data.status, {
          jobId: data.id,
          language: data.language,
          captionCount: data.captionCount,
          transcript: data.transcript,
          subtitles: data.subtitles,
          languages: data.languages,
          errorMessage: data.errorMessage,
          tier: 'tier3_browser',
        });

        if (data.status !== 'queued' && data.status !== 'processing') {
          clearInterval(pollInterval);
          pollInterval = null;
        }
      } catch (err) {
        console.error('Polling error:', err);
      }
    }, 2000);
  }

  // Submit Handler
  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    const url = urlInput.value.trim();
    if (!url) return;

    if (pollInterval) {
      clearInterval(pollInterval);
      pollInterval = null;
    }

    loadTurnstile();
    let turnstileToken = null;
    try {
      if (window.turnstile && typeof window.turnstile.getResponse === 'function') {
        turnstileToken = (turnstileWidgetId !== null ? window.turnstile.getResponse(turnstileWidgetId) : null) || window.turnstile.getResponse();
      }
    } catch (tErr) {
      console.warn('Could not read Turnstile token:', tErr);
    }

    setSubmittingState(true);
    statusCard.classList.remove('hidden');
    updateStatusUI('processing', { message: 'Analyzing TikTok video link (Instant Engine)...' });

    try {
      const res = await fetch(`${API_BASE}/api/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url,
          'cf-turnstile-response': turnstileToken,
          turnstileToken,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        const errMsg = data.details || data.error || 'Failed to submit link';
        updateStatusUI('error', { errorMessage: errMsg });
        return;
      }

      if (data.status === 'done') {
        updateStatusUI('done', {
          jobId: data.jobId,
          language: data.language,
          captionCount: data.captionCount,
          transcript: data.transcript,
          subtitles: data.subtitles,
          languages: data.languages,
          cached: data.cached,
          tier: data.tier,
        });
        return;
      }

      updateStatusUI(data.status || 'queued', {
        jobId: data.jobId,
        tier: data.tier,
      });
      pollJobStatus(data.jobId);
    } catch (err) {
      updateStatusUI('error', {
        errorMessage: 'Unable to connect to the subtitle extraction server.',
      });
    } finally {
      setSubmittingState(false);
      try {
        if (window.turnstile && typeof window.turnstile.reset === 'function') {
          if (turnstileWidgetId !== null) {
            window.turnstile.reset(turnstileWidgetId);
          } else {
            window.turnstile.reset();
          }
        }
      } catch (rErr) {
        console.warn('Could not reset Turnstile widget:', rErr);
      }
    }
  });

  // =========================================================================
  // Accordion FAQ Controller
  // =========================================================================
  const faqQuestions = document.querySelectorAll('.faq-question');
  faqQuestions.forEach((btn) => {
    btn.addEventListener('click', () => {
      const item = btn.closest('.faq-item');
      if (!item) return;
      const isActive = item.classList.contains('active');

      // Close other open accordion items
      document.querySelectorAll('.faq-item.active').forEach((other) => {
        if (other !== item) other.classList.remove('active');
      });

      // Toggle clicked item
      item.classList.toggle('active', !isActive);
    });
  });

  // =========================================================================
  // Feedback Modal Controller (English)
  // =========================================================================
  const feedbackModal = document.getElementById('feedback-modal');
  const feedbackOpenBtn = document.getElementById('feedback-open-btn');
  const feedbackCloseBtn = document.getElementById('feedback-close-btn');
  const feedbackCancelBtn = document.getElementById('feedback-cancel-btn');
  const feedbackForm = document.getElementById('feedback-form');
  const feedbackMessage = document.getElementById('feedback-message');
  const feedbackContact = document.getElementById('feedback-contact');
  const feedbackSubmitBtn = document.getElementById('feedback-submit-btn');
  const feedbackSpinner = document.getElementById('feedback-spinner');
  const feedbackStatusMsg = document.getElementById('feedback-status-msg');
  const charCount = document.getElementById('char-count');

  function openFeedbackModal() {
    if (!feedbackModal) return;
    feedbackModal.classList.remove('hidden');
    if (feedbackStatusMsg) {
      feedbackStatusMsg.className = 'feedback-status-msg hidden';
      feedbackStatusMsg.textContent = '';
    }
    if (feedbackMessage) {
      feedbackMessage.focus();
    }
  }

  function closeFeedbackModal() {
    if (!feedbackModal) return;
    feedbackModal.classList.add('hidden');
  }

  if (feedbackOpenBtn) {
    feedbackOpenBtn.addEventListener('click', () => {
      loadTurnstile();
      openFeedbackModal();
    });
  }
  if (feedbackCloseBtn) feedbackCloseBtn.addEventListener('click', closeFeedbackModal);
  if (feedbackCancelBtn) feedbackCancelBtn.addEventListener('click', closeFeedbackModal);

  if (feedbackModal) {
    feedbackModal.addEventListener('click', (e) => {
      if (e.target === feedbackModal) closeFeedbackModal();
    });
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && feedbackModal && !feedbackModal.classList.contains('hidden')) {
      closeFeedbackModal();
    }
  });

  if (feedbackMessage && charCount) {
    feedbackMessage.addEventListener('input', () => {
      charCount.textContent = feedbackMessage.value.length;
    });
  }

  if (feedbackForm) {
    feedbackForm.addEventListener('submit', async (e) => {
      e.preventDefault();

      const message = feedbackMessage.value.trim();
      const optionalContact = feedbackContact.value.trim();

      if (!message || message.length < 5) {
        if (feedbackStatusMsg) {
          feedbackStatusMsg.className = 'feedback-status-msg error';
          feedbackStatusMsg.textContent = 'Please enter at least 5 characters.';
          feedbackStatusMsg.classList.remove('hidden');
        }
        return;
      }

      loadTurnstile();
      let turnstileToken = null;
      try {
        if (window.turnstile && typeof window.turnstile.getResponse === 'function') {
          turnstileToken = (turnstileWidgetId !== null ? window.turnstile.getResponse(turnstileWidgetId) : null) || window.turnstile.getResponse();
        }
      } catch (tErr) {
        console.warn('Could not read Turnstile token:', tErr);
      }

      feedbackSubmitBtn.disabled = true;
      feedbackSpinner.classList.remove('hidden');
      const submitText = feedbackSubmitBtn.querySelector('.btn-text');
      if (submitText) submitText.textContent = 'Sending...';

      if (feedbackStatusMsg) {
        feedbackStatusMsg.className = 'feedback-status-msg hidden';
      }

      try {
        const res = await fetch(`${API_BASE}/api/feedback`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message,
            optionalContact: optionalContact || undefined,
            turnstileToken,
            'cf-turnstile-response': turnstileToken,
          }),
        });

        const data = await res.json();

        if (res.ok) {
          if (feedbackStatusMsg) {
            feedbackStatusMsg.className = 'feedback-status-msg success';
            feedbackStatusMsg.textContent = 'Thank you! Your message was sent directly to the developer.';
            feedbackStatusMsg.classList.remove('hidden');
          }
          feedbackForm.reset();
          if (charCount) charCount.textContent = '0';

          setTimeout(() => {
            closeFeedbackModal();
          }, 2000);
        } else {
          const errMsg = data.details || data.error || 'Failed to submit feedback.';
          if (feedbackStatusMsg) {
            feedbackStatusMsg.className = 'feedback-status-msg error';
            feedbackStatusMsg.textContent = errMsg;
            feedbackStatusMsg.classList.remove('hidden');
          }
        }
      } catch (err) {
        if (feedbackStatusMsg) {
          feedbackStatusMsg.className = 'feedback-status-msg error';
          feedbackStatusMsg.textContent = 'Connection to feedback server failed.';
          feedbackStatusMsg.classList.remove('hidden');
        }
      } finally {
        feedbackSubmitBtn.disabled = false;
        feedbackSpinner.classList.add('hidden');
        if (submitText) submitText.textContent = 'Send Feedback';

          try {
            if (window.turnstile && typeof window.turnstile.reset === 'function') {
              if (turnstileWidgetId !== null) {
                window.turnstile.reset(turnstileWidgetId);
              } else {
                window.turnstile.reset();
              }
            }
          } catch (rErr) {
            console.warn('Could not reset Turnstile widget:', rErr);
          }
      }
    });
  }

  // =========================================================================
  // Developer API Tabs & Copy Controller
  // =========================================================================
  const devTabBtns = document.querySelectorAll('.dev-api-section .tab-btn');
  const devTabPanes = document.querySelectorAll('.dev-api-section .tab-pane');
  const codeLangLabel = document.getElementById('code-lang-label');
  const copyCodeBtn = document.getElementById('copy-code-btn');
  const copyCodeText = document.getElementById('copy-code-text');

  const langNames = {
    'tab-curl': 'cURL',
    'tab-python': 'Python',
    'tab-js': 'JavaScript',
  };

  devTabBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      const targetId = btn.getAttribute('data-tab');
      if (!targetId) return;

      devTabBtns.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');

      devTabPanes.forEach((pane) => {
        if (pane.id === targetId) {
          pane.classList.remove('hidden');
        } else {
          pane.classList.add('hidden');
        }
      });

      if (codeLangLabel && langNames[targetId]) {
        codeLangLabel.textContent = langNames[targetId];
      }
    });
  });

  if (copyCodeBtn) {
    copyCodeBtn.addEventListener('click', async () => {
      const activePane = document.querySelector('.dev-api-section .tab-pane:not(.hidden)');
      if (!activePane) return;

      const codeElement = activePane.querySelector('.code-content');
      if (!codeElement) return;

      const text = codeElement.textContent || '';
      try {
        await navigator.clipboard.writeText(text);
        if (copyCodeText) copyCodeText.textContent = 'Copied!';
        copyCodeBtn.classList.add('copied');
        setTimeout(() => {
          if (copyCodeText) copyCodeText.textContent = 'Copy';
          copyCodeBtn.classList.remove('copied');
        }, 2000);
      } catch (err) {
        console.warn('Failed to copy code snippet to clipboard:', err);
      }
    });
  }
});
