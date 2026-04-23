/**
 * Idempotent create for TOKENS_TABLE and USER_VITALS_TABLE (same key shapes as Fitbit / vitals7api-vitals).
 * Set AUTO_CREATE_DYNAMODB_TABLES=false to skip (e.g. production where tables are managed by IaC).
 */
const {
  CreateTableCommand,
  DescribeTableCommand,
} = require('@aws-sdk/client-dynamodb');
const awsClient = require('./aws-client');

const TOKENS_TABLE = process.env.TOKENS_TABLE || 'vitals-di-tokens';
const USER_VITALS_TABLE = process.env.USER_VITALS_TABLE || 'user_vitals';

async function waitActive(raw, tableName, maxAttempts = 40) {
  for (let i = 0; i < maxAttempts; i++) {
    const out = await raw.send(new DescribeTableCommand({ TableName: tableName }));
    if (out.Table?.TableStatus === 'ACTIVE') return;
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`Table ${tableName} did not become ACTIVE in time`);
}

async function ensureTable(raw, def) {
  const { TableName } = def;
  try {
    await raw.send(new DescribeTableCommand({ TableName }));
    return false;
  } catch (e) {
    if (e.name !== 'ResourceNotFoundException') throw e;
  }
  try {
    await raw.send(
      new CreateTableCommand({
        ...def,
        BillingMode: def.BillingMode || 'PAY_PER_REQUEST',
      })
    );
  } catch (e) {
    if (e.name === 'ResourceInUseException') return false;
    throw e;
  }
  await waitActive(raw, TableName);
  return true;
}

async function ensureVitalsDiTables() {
  if (String(process.env.AUTO_CREATE_DYNAMODB_TABLES || 'true').toLowerCase() === 'false') {
    console.log('ℹ️ AUTO_CREATE_DYNAMODB_TABLES=false — skipping DynamoDB table ensure');
    return;
  }
  const raw = awsClient.rawClient;
  const created = [];

  if (
    await ensureTable(raw, {
      TableName: TOKENS_TABLE,
      KeySchema: [{ AttributeName: 'userId', KeyType: 'HASH' }],
      AttributeDefinitions: [{ AttributeName: 'userId', AttributeType: 'S' }],
    })
  ) {
    created.push(TOKENS_TABLE);
  } else {
    console.log(`ℹ️ DynamoDB table exists: ${TOKENS_TABLE}`);
  }

  if (
    await ensureTable(raw, {
      TableName: USER_VITALS_TABLE,
      KeySchema: [
        { AttributeName: 'user_id', KeyType: 'HASH' },
        { AttributeName: 'item_key', KeyType: 'RANGE' },
      ],
      AttributeDefinitions: [
        { AttributeName: 'user_id', AttributeType: 'S' },
        { AttributeName: 'item_key', AttributeType: 'S' },
      ],
    })
  ) {
    created.push(USER_VITALS_TABLE);
  } else {
    console.log(`ℹ️ DynamoDB table exists: ${USER_VITALS_TABLE}`);
  }

  if (created.length) {
    console.log(`✅ Created DynamoDB table(s): ${created.join(', ')}`);
  }
}

module.exports = { ensureVitalsDiTables, TOKENS_TABLE, USER_VITALS_TABLE };
