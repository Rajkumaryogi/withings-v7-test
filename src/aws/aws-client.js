/**
 * AWS DynamoDB client — vitals-di-tokens + user_vitals (table names from env).
 */
require('dotenv').config();
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
  DeleteCommand,
  QueryCommand,
  ScanCommand,
  BatchWriteCommand,
} = require('@aws-sdk/lib-dynamodb');

class AWSClient {
  constructor() {
    const credentials =
      process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
        ? {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID,
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
            ...(process.env.AWS_SESSION_TOKEN ? { sessionToken: process.env.AWS_SESSION_TOKEN } : {}),
          }
        : undefined;
    this.rawClient = new DynamoDBClient({
      region: process.env.AWS_REGION || 'us-east-1',
      ...(process.env.AWS_DYNAMODB_ENDPOINT ? { endpoint: process.env.AWS_DYNAMODB_ENDPOINT } : {}),
      ...(credentials ? { credentials } : {}),
    });
    this.client = DynamoDBDocumentClient.from(this.rawClient, {
      marshallOptions: { removeUndefinedValues: true },
    });
  }

  async get(params) {
    return this.client.send(new GetCommand(params));
  }

  async put(params) {
    return this.client.send(new PutCommand(params));
  }

  async update(params) {
    return this.client.send(new UpdateCommand(params));
  }

  async delete(params) {
    return this.client.send(new DeleteCommand(params));
  }

  async query(params) {
    return this.client.send(new QueryCommand(params));
  }

  async scan(params) {
    return this.client.send(new ScanCommand(params));
  }

  async batchWrite(params) {
    return this.client.send(new BatchWriteCommand(params));
  }
}

const awsClient = new AWSClient();
module.exports = awsClient;
