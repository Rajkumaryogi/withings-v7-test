/**
 * Shared Withings → DynamoDB user_vitals sync (used by server, OAuth callback, webhook, CLI).
 * Tokens: vitals-di-tokens only. Readings: user_vitals only — no local JSON.
 */
const axios = require('axios');
const tokenManager = require('./utils/token-manager');
const withingsAPI = require('./api');
const dynamodb = require('./aws/dynamodb-client');
const { savePayloadsToUserVitals } = require('./aws/user-vitals-writer');
const { allPayloads } = require('./withings-to-vitals7');

function getCurrentTimestamp() {
  return Math.round(Date.now() / 1000);
}

async function publishRealtimeGateway(cognitoUserId, source = 'withings') {
  const base = (process.env.VITALS_REALTIME_GATEWAY_URL || 'http://localhost:8095').replace(/\/$/, '');
  const secret = process.env.VITALS_REALTIME_GATEWAY_SECRET || 'vitals7-local-dev-realtime';
  try {
    await axios.post(
      `${base}/internal/publish`,
      {
        userId: String(cognitoUserId),
        type: 'vitals7_refresh',
        source,
        data: { at: new Date().toISOString() },
      },
      { headers: { 'X-Gateway-Secret': secret }, timeout: 5000 }
    );
  } catch (e) {
    console.warn('Realtime gateway publish failed:', e.message);
  }
}

async function syncWithingsToUserVitals(bareCognitoUserId, withingsData) {
  const row = await dynamodb.getTokens(bareCognitoUserId);
  const payloads = allPayloads(withingsData, bareCognitoUserId, 'Withings');
  const lastPushAt = Number(row?.last_vitals7_push_at) || 0;
  const newPayloads = lastPushAt
    ? payloads.filter((p) => {
        const ts = new Date(p.recordedAt).getTime();
        return isNaN(ts) || ts > lastPushAt;
      })
    : payloads;
  if (lastPushAt && newPayloads.length < payloads.length) {
    console.log(`📤 Filtering Withings: ${newPayloads.length} new of ${payloads.length} payloads for user_vitals`);
  }
  if (newPayloads.length > 0) {
    await savePayloadsToUserVitals(bareCognitoUserId, newPayloads);
    try {
      await dynamodb.updateLastVitals7PushAt(bareCognitoUserId, Date.now());
    } catch (e) {
      console.warn('⚠️ Failed to update last_vitals7_push_at:', e.message);
    }
  } else {
    console.log('📤 No new Withings payloads for user_vitals');
  }
  await publishRealtimeGateway(bareCognitoUserId, 'withings');
}

function dynamoRowToWithingsTokens(row) {
  if (!row || !row.access_token) return {};
  return {
    access_token: row.access_token,
    refresh_token: row.refresh_token || '',
    userid: row.withings_userid || row.userId,
    cognitoUserId: row.userId,
    access_token_timestamp: row.created_at ? Math.floor(row.created_at / 1000) : getCurrentTimestamp(),
    refresh_token_timestamp: row.created_at ? Math.floor(row.created_at / 1000) : getCurrentTimestamp(),
  };
}

function transformWithingsData(data) {
  const result = {
    connected: true,
    lastSynced: data.fetched_at || new Date().toISOString(),
    userid: data.user?.user?.id,
    devices: data.devices?.devices || [],
    weight: null,
    bodyComposition: {},
    activity: data.activity?.activities || [],
    sleep: data.sleep?.series || [],
    metrics: data.metrics?.measuregrps || [],
  };

  if (data.metrics?.measuregrps && data.metrics.measuregrps.length > 0) {
    const latestGroup = data.metrics.measuregrps[0];
    const measures = {};

    latestGroup.measures.forEach((m) => {
      const value = m.value * Math.pow(10, m.unit);
      switch (m.type) {
        case 1:
          measures.weight = value;
          break;
        case 4:
          measures.height = value;
          break;
        case 5:
          measures.fatFreeMass = value;
          break;
        case 6:
          measures.fatRatio = value;
          break;
        case 8:
          measures.fatMass = value;
          break;
        case 76:
          measures.muscleMass = value;
          break;
        case 77:
          measures.bodyWater = value;
          break;
        case 88:
          measures.boneMass = value;
          break;
        default:
          break;
      }
    });

    if (measures.weight) {
      result.weight = {
        value: measures.weight,
        unit: 'kg',
        date: new Date(latestGroup.date * 1000).toISOString(),
      };
    }

    if (measures.weight && measures.height) {
      measures.bmi = +(measures.weight / (measures.height * measures.height)).toFixed(1);
    }

    result.bodyComposition = {
      height: measures.height != null ? +measures.height.toFixed(3) : null,
      bmi: measures.bmi != null ? measures.bmi : null,
      fatMass: measures.fatMass != null ? +measures.fatMass.toFixed(3) : null,
      fatRatio: measures.fatRatio != null ? +measures.fatRatio.toFixed(2) : null,
      muscleMass: measures.muscleMass != null ? +measures.muscleMass.toFixed(3) : null,
      boneMass: measures.boneMass != null ? +measures.boneMass.toFixed(3) : null,
      bodyWater: measures.bodyWater != null ? +measures.bodyWater.toFixed(2) : null,
      fatFreeMass: measures.fatFreeMass != null ? +measures.fatFreeMass.toFixed(3) : null,
    };
  }

  return result;
}

function bareCognitoForWithings(userId) {
  const s = String(userId || '');
  return s.replace(/#withings$/i, '') || s;
}

async function runWithingsSyncForUser(cognitoUserId) {
  const userId = bareCognitoForWithings(cognitoUserId);
  const row = await dynamodb.getTokens(userId);
  if (!row || !row.access_token) {
    throw new Error('No Withings tokens found for user.');
  }
  tokenManager.setTokens(dynamoRowToWithingsTokens(row));

  const freshData = await withingsAPI.getAllData();
  await syncWithingsToUserVitals(userId, freshData);

  return transformWithingsData(freshData);
}

module.exports = {
  getCurrentTimestamp,
  publishRealtimeGateway,
  syncWithingsToUserVitals,
  dynamoRowToWithingsTokens,
  transformWithingsData,
  bareCognitoForWithings,
  runWithingsSyncForUser,
};
