/**
 * Withings Data Notification API — subscribe so new cloud data triggers your webhook.
 * @see https://developer.withings.com/developer-guide/v3/data-api/notifications/notification-subscribe
 */
const axios = require('axios');
const config = require('../config.json');

const DEFAULT_APLIS = [1, 2, 4, 16, 44, 50, 51];

function parseAppliList() {
  const raw = process.env.WITHINGS_NOTIFY_APPLIS;
  if (!raw || !String(raw).trim()) return DEFAULT_APLIS;
  return String(raw)
    .split(',')
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 0);
}

/**
 * POST root wbsapi.withings.net with form body (same pattern as OAuth).
 */
async function notifyRequest(accessToken, formParams) {
  const body = new URLSearchParams(formParams).toString();
  const baseUrl = process.env.WITHINGS_NOTIFY_API_URL || config.api_endpoint;
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
        console.warn(`Withings notify subscribe appli=${appli} non-zero status:`, data?.status, data?.body);
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
  parseAppliList,
  DEFAULT_APLIS,
};
