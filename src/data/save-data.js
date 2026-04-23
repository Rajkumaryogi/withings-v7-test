/**
 * CLI: sync Withings → DynamoDB user_vitals (no local JSON).
 * Tokens must already exist in vitals-di-tokens (connect via Vitals7 / server OAuth).
 */
require('dotenv').config();
const { ensureVitalsDiTables } = require('../aws/ensure-tables');
const { runWithingsSyncForUser } = require('../withings-sync-service');

function resolveCognitoUserId() {
  const argv = process.argv[2];
  if (argv && String(argv).trim()) return String(argv).trim();
  const env = process.env.COGNITO_USER_ID || process.env.WITHINGS_SYNC_USER_ID;
  if (env && String(env).trim()) return String(env).trim();
  return null;
}

async function syncToUserVitalsCli() {
  const cognito = resolveCognitoUserId();
  if (!cognito) {
    console.error('Missing Cognito user id. Usage:');
    console.error('  COGNITO_USER_ID=<uuid> npm run get-data');
    console.error('  npm run get-data -- <uuid>');
    console.error('  node src/data/save-data.js <uuid>');
    process.exit(1);
  }
  try {
    await ensureVitalsDiTables();
  } catch (e) {
    console.warn('DynamoDB ensure-tables:', e.message);
  }
  console.log('Syncing Withings → user_vitals for Cognito user', cognito.slice(0, 8) + '...');
  const summary = await runWithingsSyncForUser(cognito);
  console.log(JSON.stringify({ ok: true, lastSynced: summary.lastSynced, userid: summary.userid }, null, 2));
            return true;
}

if (require.main === module) {
  syncToUserVitalsCli()
    .then((ok) => process.exit(ok ? 0 : 1))
    .catch((err) => {
      console.error(err.message || err);
      process.exit(1);
    });
}

module.exports = {
  syncToUserVitalsCli,
};
