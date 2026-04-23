/**
 * DynamoDB client for Withings — tokens in vitals-di-tokens; readings go to user_vitals via user-vitals-writer.
 */
const awsClient = require('./aws-client');

const TOKENS_TABLE = process.env.TOKENS_TABLE || 'vitals-di-tokens';
const API_NAME = 'Withings';
const WITHINGS_KEY_SUFFIX = '#withings';

function withingsKey(cognitoUserId) {
  return `${cognitoUserId}${WITHINGS_KEY_SUFFIX}`;
}

/**
 * Save Withings tokens. tokenData: { UserID (=cognitoUserId), AccessToken, RefreshToken, Expires, APIName?, token_type? }
 * Key = {UserID}#withings so each device gets its own row per user and connectors don't overwrite each other.
 */
async function saveTokens(tokenData) {
  const now = Date.now();
  const expiresInMs = (tokenData.Expires || 10800) * 1000;
  const Item = {
    userId: withingsKey(tokenData.UserID),
    cognito_user_id: tokenData.UserID,
    access_token: tokenData.AccessToken,
    refresh_token: tokenData.RefreshToken || '',
    expires_in: tokenData.Expires || 10800,
    expires_at: now + expiresInMs,
    created_at: now,
    updated_at: now,
    api_name: tokenData.APIName || API_NAME,
    token_type: tokenData.token_type || 'bearer',
  };
  if (tokenData.WithingsUserid) Item.withings_userid = tokenData.WithingsUserid;
  await awsClient.put({ TableName: TOKENS_TABLE, Item });
  console.log('💾 Saved Withings tokens to DynamoDB for user', tokenData.UserID, '(key', Item.userId + ')');
  return Item;
}

/**
 * Get Withings tokens for a Cognito user. Tries {userId}#withings first, falls back to bare userId (old format).
 */
async function getTokens(userId) {
  // New format: key includes #withings suffix
  const res = await awsClient.get({ TableName: TOKENS_TABLE, Key: { userId: withingsKey(userId) } });
  if (res.Item) return res.Item;
  // Backward-compat: old rows stored with bare cognitoUserId
  const res2 = await awsClient.get({ TableName: TOKENS_TABLE, Key: { userId } });
  const item2 = res2.Item;
  if (item2 && String(item2.api_name || '').toLowerCase() === 'withings') return item2;
  return null;
}

/**
 * Get one Withings token row (for status / sync when we don't have userId).
 */
async function getOneWithingsToken() {
  const res = await awsClient.scan({
    TableName: TOKENS_TABLE,
    FilterExpression: 'api_name = :fn',
    ExpressionAttributeValues: { ':fn': API_NAME },
  });
  return (res.Items && res.Items[0]) || null;
}

async function hasAnyWithingsTokens() {
  const row = await getOneWithingsToken();
  return !!row;
}

async function removeTokens(userId) {
  // Delete new-format key
  await awsClient.delete({ TableName: TOKENS_TABLE, Key: { userId: withingsKey(userId) } });
  // Also delete old-format key (bare cognitoUserId) for backward compat
  const old = await awsClient.get({ TableName: TOKENS_TABLE, Key: { userId } });
  if (old.Item && String(old.Item.api_name || '').toLowerCase() === 'withings') {
    await awsClient.delete({ TableName: TOKENS_TABLE, Key: { userId } });
  }
  console.log('🗑 Removed Withings tokens from DynamoDB for user', userId);
}

async function removeAllWithingsTokens() {
  const res = await awsClient.scan({
    TableName: TOKENS_TABLE,
    FilterExpression: 'api_name = :fn',
    ExpressionAttributeValues: { ':fn': API_NAME },
    ProjectionExpression: 'userId',
  });
  const items = res.Items || [];
  for (const it of items) {
    await awsClient.delete({
      TableName: TOKENS_TABLE,
      Key: { userId: it.userId },
    });
  }
  console.log('🗑 Removed', items.length, 'Withings token row(s) from DynamoDB');
  return items.length;
}

/** Deprecated: raw health cache removed — use user_vitals only. */
async function saveHealthData() {
  return 0;
}

async function updateLastVitals7PushAt(userId, timestamp) {
  const key = withingsKey(userId);
  await awsClient.update({
    TableName: TOKENS_TABLE,
    Key: { userId: key },
    UpdateExpression: 'SET last_vitals7_push_at = :ts, updated_at = :now',
    ExpressionAttributeValues: { ':ts': timestamp, ':now': Date.now() },
  });
}

/**
 * Map Withings API userid (from notification webhook) to Cognito sub.
 */
async function findCognitoByWithingsUserid(withingsUserId) {
  const wid = String(withingsUserId);
  const res = await awsClient.scan({
    TableName: TOKENS_TABLE,
    FilterExpression: 'api_name = :fn AND withings_userid = :wid',
    ExpressionAttributeValues: { ':fn': API_NAME, ':wid': wid },
  });
  const item = (res.Items && res.Items[0]) || null;
  if (!item) return null;
  if (item.cognito_user_id) return String(item.cognito_user_id);
  const uid = item.userId || '';
  if (uid.endsWith(WITHINGS_KEY_SUFFIX)) return uid.slice(0, -WITHINGS_KEY_SUFFIX.length);
  return null;
}

module.exports = {
  saveTokens,
  getTokens,
  getOneWithingsToken,
  hasAnyWithingsTokens,
  removeTokens,
  removeAllWithingsTokens,
  saveHealthData,
  updateLastVitals7PushAt,
  findCognitoByWithingsUserid,
};
