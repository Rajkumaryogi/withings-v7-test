/**
 * Withings Data Notification API — subscribe so new cloud data triggers your webhook.
 * @see https://developer.withings.com/developer-guide/v3/data-api/notifications/notification-subscribe
 */
const axios = require('axios');
const config = require('../config.json');

const DEFAULT_APLIS = [1, 2, 4, 16, 44, 50, 51];

/**
 * Notify subscribe uses …/notify (legacy path). Withings’ own client uses path `notify`, and the
 * OAuth scope table ties Notify–Subscribe to user.info / user.metrics / user.activity for that service.
 * POSTing to https://wbsapi.withings.net/ (no path) → 2554 Not implemented.
 * POSTing to …/v2/notify often returns Insufficient_scope for normal Public API tokens.
 * Set WITHINGS_NOTIFY_USE_V2=1 to force …/v2/notify if your program requires it.
 */
function getNotifyApiUrl() {
  const base = String(config.api_endpoint || 'https://wbsapi.withings.net').replace(/\/$/, '');
  const legacyNotify = `${base}/notify`;
  const v2Notify = `${base}/v2/notify`;

  if (String(process.env.WITHINGS_NOTIFY_USE_V2 || '').trim() === '1') {
    return v2Notify;
  }

  const raw = process.env.WITHINGS_NOTIFY_API_URL;
  if (!raw || !String(raw).trim()) return legacyNotify;

  let trimmed = String(raw).trim().replace(/\/$/, '');

  if (/\/v2\/notify$/i.test(trimmed)) {
    console.warn(
      'Withings notify: WITHINGS_NOTIFY_API_URL ends with /v2/notify; using %s (v2 often returns Insufficient_scope). Set WITHINGS_NOTIFY_USE_V2=1 to keep v2.',
      legacyNotify
    );
    return legacyNotify;
  }

  if (trimmed.endsWith('/notify')) return trimmed;

  try {
    const href = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    const u = new URL(href);
    if (u.hostname.toLowerCase() === 'wbsapi.withings.net' && (!u.pathname || u.pathname === '/')) {
      console.warn(
        'Withings notify: WITHINGS_NOTIFY_API_URL is the bare wbsapi host; using %s.',
        legacyNotify
      );
      return legacyNotify;
    }
  } catch (_) {
    /* keep trimmed */
  }

  return trimmed;
}

function parseAppliList() {
  const raw = process.env.WITHINGS_NOTIFY_APPLIS;
  if (!raw || !String(raw).trim()) return DEFAULT_APLIS;
  return String(raw)
    .split(',')
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 0);
}

/**
 * POST …/notify with form body (Bearer token).
 */
async function notifyRequest(accessToken, formParams) {
  const body = new URLSearchParams(formParams).toString();
  const baseUrl = getNotifyApiUrl();
  const res = await axios.post(baseUrl, body, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    timeout: 20000,
  });
  return res.data;
}

/**
 * Subscribe one appli (data category) to callbackurl.
 */
async function subscribe(accessToken, callbackUrl, appli, comment) {
  return notifyRequest(accessToken, {
    action: 'subscribe',
    callbackurl: callbackUrl,
    appli: String(appli),
    comment: comment || `Vitals7-${appli}`,
  });
}

/**
 * Subscribe all configured categories so new readings trigger the webhook.
 * callbackUrl must be HTTPS in production and registered in Withings Developer Portal.
 */
async function subscribeAllForAccessToken(accessToken, callbackUrl) {
  if (!callbackUrl || !String(callbackUrl).trim()) {
    console.warn('Withings notify: WITHINGS_WEBHOOK_URL not set; skipping subscription.');
    return { skipped: true, results: [] };
  }
  const url = String(callbackUrl).trim();
  const aplis = parseAppliList();
  const results = [];
  for (const appli of aplis) {
    try {
      const data = await subscribe(accessToken, url, appli, `Vitals7-appli-${appli}`);
      const ok = data && Number(data.status) === 0;
      results.push({ appli, ok, status: data?.status, body: data?.body });
      if (!ok) {
        const detail =
          data && typeof data === 'object'
            ? JSON.stringify(data).slice(0, 500)
            : String(data);
        console.warn(
          `Withings notify subscribe appli=${appli} non-zero status (POST ${getNotifyApiUrl()}):`,
          detail
        );
      } else {
        console.log(`Withings notify subscribed appli=${appli}`);
      }
    } catch (e) {
      const msg = e.response?.data || e.message;
      console.warn(`Withings notify subscribe appli=${appli} failed:`, msg);
      results.push({ appli, ok: false, error: String(msg) });
    }
  }
  return { skipped: false, results };
}

module.exports = {
  subscribe,
  subscribeAllForAccessToken,
  getNotifyApiUrl,
  parseAppliList,
  DEFAULT_APLIS,
};
