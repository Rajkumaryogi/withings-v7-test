#!/usr/bin/env node
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const tokenManager = require('./utils/token-manager');
const config = require('../config.json');
const withingsAPI = require('./api');
const crypto = require('crypto');
const dynamodb = require('./aws/dynamodb-client');
const { ensureVitalsDiTables } = require('./aws/ensure-tables');
const {
    bareCognitoForWithings,
    dynamoRowToWithingsTokens,
    syncWithingsToUserVitals,
    runWithingsSyncForUser,
    transformWithingsData,
} = require('./withings-sync-service');
const { subscribeAllForAccessToken, getNotifyApiUrl } = require('./withings-notify');

/** Public URL Withings will POST to (must match Developer Portal callback allowlist). */
function resolveWithingsWebhookUrl() {
    const full = process.env.WITHINGS_WEBHOOK_URL;
    if (full && String(full).trim()) return String(full).trim();
    const base = process.env.PUBLIC_WEBHOOK_BASE_URL || process.env.WITHINGS_PUBLIC_BASE_URL;
    if (base && String(base).trim()) {
        return `${String(base).trim().replace(/\/$/, '')}/webhook/withings`;
    }
    return '';
}

/** OAuth redirect_uri must match Withings app settings; override per env (e.g. Render) without invalid JSON in config.json. */
function getWithingsRedirectUri() {
    const fromEnv = (process.env.WITHINGS_REDIRECT_URI || '').trim();
    if (fromEnv) return fromEnv;
    return String(config.redirect_uri || '').trim();
}

function buildSuccessHtml() {
  return `<!DOCTYPE html>
<html>
<head><title>Withings Connected</title>
<style>body{font-family:Arial;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%)}.container{background:#fff;padding:40px;border-radius:10px;box-shadow:0 10px 40px rgba(0,0,0,.1);text-align:center;max-width:500px}h1{color:#333}p{color:#666}.success-icon{font-size:60px;color:#4CAF50}button{background:#667eea;color:#fff;border:none;padding:12px 30px;border-radius:5px;font-size:16px;cursor:pointer}</style>
</head>
<body><div class="container"><div class="success-icon">✓</div><h1>Withings Connected!</h1><p>You can close this window and return to Vitals7.</p><button onclick="window.close()">Close</button></div>
<script>if(window.opener){window.opener.postMessage({type:'WITHINGS_AUTH_COMPLETE',success:true,timestamp:new Date().toISOString()},'*');}setTimeout(function(){window.close();},3000);</script>
</body></html>`;
}

const app = express();
const PORT = process.env.PORT || 5001;

// Helper functions for OAuth
function sign(params) {
    const params_to_sign = {
        action: params.action,
        client_id: params.client_id
    };
    
    if (params.timestamp) {
        params_to_sign.timestamp = params.timestamp;
    }
    if (params.nonce) {
        params_to_sign.nonce = params.nonce;
    }
    
    // Sort parameters alphabetically
    const sorted_keys = Object.keys(params_to_sign).sort();
    const sorted_values = sorted_keys.map(key => params_to_sign[key]).join(',');
    
    const hmac = crypto.createHmac('sha256', config.client_secret);
    hmac.update(sorted_values);
    return hmac.digest("hex");
}

function getCurrentTimestamp() {
    return Math.round(Date.now() / 1000);
}

async function getNonce(timestamp) {
    try {
        const params = {
            action: 'getnonce',
            client_id: config.client_id,
            timestamp: timestamp
        };
        
        params.signature = sign(params);
        
        const response = await axios.post(`${config.api_endpoint}/v2/signature`, params);
        return response.data.body.nonce;
    } catch (error) {
        console.error('Error getting nonce:', error.response?.data || error.message);
        throw error;
    }
}

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// CORS middleware
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
    if (req.method === 'OPTIONS') {
        res.sendStatus(200);
    } else {
        next();
    }
});

// API Routes (tokens from DynamoDB only)
app.get('/api/status', async (req, res) => {
    try {
        const hasTokens = await dynamodb.hasAnyWithingsTokens();
        if (hasTokens) {
            const row = await dynamodb.getOneWithingsToken();
            res.json({
                authenticated: true,
                userid: row?.withings_userid || row?.userId,
                message: 'Connected via DynamoDB (Vitals7)'
            });
        } else {
            res.json({ authenticated: false, message: 'Not authenticated. Please connect via Vitals7.' });
        }
    } catch (e) {
        res.status(500).json({ authenticated: false, error: e.message });
    }
});

// Vitals7 Connect flow: frontend opens this URL with state=cognitoUserId, we redirect to Withings OAuth with that state
app.get('/login', (req, res) => {
    try {
        const state = req.query.state || config.state;
        const authUrl = new URL(config.auth_url);
        authUrl.searchParams.set('response_type', 'code');
        authUrl.searchParams.set('client_id', config.client_id);
        authUrl.searchParams.set('scope', config.scopes);
        authUrl.searchParams.set('redirect_uri', getWithingsRedirectUri());
        authUrl.searchParams.set('state', state);
        res.redirect(authUrl.toString());
    } catch (error) {
        console.error('Login redirect error:', error);
        res.status(500).send('Failed to redirect to Withings');
    }
});

// Optional: frontend can call before connect — no HTTP Vitals API; data goes to user_vitals only.
app.post('/api/vitals7/configure', (req, res) => {
    try {
        const { cognitoUserId } = req.body || {};
        if (!cognitoUserId) {
            return res.status(400).json({ error: 'cognitoUserId is required' });
        }
        console.log('Withings connector configure acknowledged for user', cognitoUserId);
        res.json({ success: true, message: 'Withings connector ready (DynamoDB user_vitals only)' });
    } catch (error) {
        console.error('Configure error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Withings API endpoints for frontend integration
app.get('/api/withings/auth/initiate', (req, res) => {
    try {
        // Build the authorization URL
        const authUrl = new URL(config.auth_url);
        authUrl.searchParams.append('response_type', 'code');
        authUrl.searchParams.append('client_id', config.client_id);
        authUrl.searchParams.append('scope', config.scopes);
        authUrl.searchParams.append('redirect_uri', getWithingsRedirectUri());
        authUrl.searchParams.append('state', config.state);
        
        res.json({
            authUrl: authUrl.toString(),
            message: 'Authorization URL generated successfully'
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/withings/status', async (req, res) => {
    try {
        const cognitoUserId = req.query.userId || req.query.userid || null;
        if (cognitoUserId) {
            const row = await dynamodb.getTokens(String(cognitoUserId));
            const apiName = String(row?.api_name || '').toLowerCase();
            const ok = row && apiName === 'withings' && row.access_token;
            return res.json({
                connected: !!ok,
                hasData: !!ok,
                userid: row?.withings_userid || row?.userId,
                message: ok ? 'Connected (DynamoDB)' : 'Not authenticated'
            });
        }
        const hasTokens = await dynamodb.hasAnyWithingsTokens();
        if (hasTokens) {
            const row = await dynamodb.getOneWithingsToken();
            return res.json({
                connected: true,
                hasData: true,
                userid: row?.withings_userid || row?.userId,
                message: 'Connected (DynamoDB)'
            });
        }
        res.json({ connected: false, hasData: false, message: 'Not authenticated' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/withings/data', async (req, res) => {
    try {
        let tokens = tokenManager.getTokens();
        if (!tokens.access_token) {
            const row = await dynamodb.getOneWithingsToken();
            if (row) tokenManager.setTokens(dynamoRowToWithingsTokens(row));
            tokens = tokenManager.getTokens();
        }
        if (!tokens.access_token) {
            return res.status(401).json({ error: 'Not authenticated. Connect via Vitals7.' });
        }

        let latestData = null;
        try {
            latestData = await withingsAPI.getAllData();
        } catch (apiError) {
            console.error('Error fetching data from Withings API:', apiError.message);
            latestData = {
                timestamp: Math.floor(Date.now() / 1000),
                fetched_at: new Date().toISOString(),
                user: { user: { id: tokens.userid } },
                devices: { devices: [] },
                activity: { activities: [] },
                metrics: { measuregrps: [] },
                sleep: { series: [] }
            };
        }
        res.json(transformWithingsData(latestData));
    } catch (error) {
        console.error('Error fetching Withings data:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/withings/sync', async (req, res) => {
    try {
        const bodyUserId = req.body?.userId || req.body?.cognitoUserId || req.query?.userId;
        const rawUserId = bodyUserId || (await dynamodb.getOneWithingsToken())?.userId;
        if (!rawUserId) {
            return res.status(401).json({ error: 'Not authenticated. Connect Withings from Vitals7 first.' });
        }
        const userId = bareCognitoForWithings(rawUserId);
        const data = await runWithingsSyncForUser(userId);
        res.json(data);
    } catch (error) {
        console.error('Error syncing Withings data:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * Withings Data Notification webhook — Withings POSTs form data (userid, appli, startdate, enddate, …).
 * Register the same public URL in the Withings Developer Portal and subscribe via API (OAuth or POST /api/withings/register-webhooks).
 */
function _webhookUserId(req) {
    const b = req.body || {};
    const q = req.query || {};
    const v = b.userid ?? b.user_id ?? q.userid ?? q.user_id;
    if (v == null || v === '') return null;
    return String(v);
}

async function handleWithingsWebhookPost(req, res) {
    try {
        const userid = _webhookUserId(req);
        const appli = parseInt(req.body?.appli ?? req.query?.appli, 10);
        const action = String(req.body?.action || req.query?.action || '')
            .toLowerCase()
            .trim();

        if (userid && appli === 46 && (action === 'unlink' || action === 'delete')) {
            const cognito = await dynamodb.findCognitoByWithingsUserid(userid);
            if (cognito) {
                try {
                    await dynamodb.removeTokens(cognito);
                    console.log('Withings webhook: removed tokens for user after', action);
                } catch (e) {
                    console.warn('Withings webhook unlink cleanup failed:', e.message);
                }
            }
            return res.status(200).type('text/plain').send('OK');
        }

        if (userid) {
            const cognito = await dynamodb.findCognitoByWithingsUserid(userid);
            if (cognito) {
                console.log('Withings webhook: userid=%s appli=%s → sync user_vitals', userid, appli || '?');
                setImmediate(() => {
                    runWithingsSyncForUser(cognito).catch((err) =>
                        console.error('Withings webhook sync failed:', err.message)
                    );
                });
            } else {
                console.warn('Withings webhook: no DynamoDB row for Withings userid=%s', userid);
            }
        } else {
            const keys = Object.keys({ ...(req.query || {}), ...(req.body || {}) });
            console.warn(
                'Withings webhook: POST with no userid (Withings only calls here after a successful subscribe; keys=%s)',
                keys.length ? keys.join(',') : 'none'
            );
        }
    } catch (e) {
        console.error('Withings webhook:', e);
    }
    return res.status(200).type('text/plain').send('OK');
}

app.get('/webhook/withings', (req, res) => {
    res.status(200).type('text/plain').send('OK');
});

app.head('/webhook/withings', (req, res) => {
    res.status(200).end();
});

app.post('/webhook/withings', handleWithingsWebhookPost);

/** Re-register Withings push subscriptions (same URL as env). Use after rotating URL or adding scopes. */
app.post('/api/withings/register-webhooks', async (req, res) => {
    try {
        const bodyUserId = req.body?.userId || req.body?.cognitoUserId || req.query?.userId;
        const one = await dynamodb.getOneWithingsToken();
        const rawUserId = bodyUserId || one?.cognito_user_id || one?.userId;
        if (!rawUserId) {
            return res.status(401).json({ error: 'userId/cognitoUserId required, or connect one Withings user first.' });
        }
        const userId = bareCognitoForWithings(String(rawUserId));
        const row = await dynamodb.getTokens(userId);
        if (!row?.access_token) {
            return res.status(401).json({ error: 'No Withings tokens for this user.' });
        }
        const hookUrl = resolveWithingsWebhookUrl();
        if (!hookUrl) {
            return res.status(400).json({
                error: 'Set WITHINGS_WEBHOOK_URL or PUBLIC_WEBHOOK_BASE_URL to your public /webhook/withings URL.',
            });
        }
        tokenManager.setTokens(dynamoRowToWithingsTokens(row));
        const accessToken = await withingsAPI.ensureValidToken();
        const out = await subscribeAllForAccessToken(accessToken, hookUrl);
        res.json({ success: true, webhookUrl: hookUrl, ...out });
    } catch (error) {
        console.error('register-webhooks:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/withings/disconnect', async (req, res) => {
    try {
        const userId = req.body?.userId || req.body?.cognitoUserId || null;
        if (!userId) {
            return res.status(400).json({
                success: false,
                error: 'userId or cognitoUserId required — disconnect is per user only',
            });
        }
        await dynamodb.removeTokens(String(userId));
        const mem = tokenManager.getTokens();
        const memCognito = mem?.cognitoUserId != null ? String(mem.cognitoUserId) : '';
        if (memCognito && memCognito === String(userId)) {
            tokenManager.clearTokens();
        }
        res.json({ success: true, message: 'Withings disconnected' });
    } catch (error) {
        console.error('Disconnect error:', error);
        res.status(500).json({ error: error.message });
    }
});

// OAuth callback handler - redirects to frontend after successful auth
app.get('/callback', async (req, res) => {
    const { code, state, error, error_description } = req.query;
    
    console.log('\n📥 Callback received:', {
        code: code ? `${code.substring(0, 10)}...` : 'none',
        state: state || 'none',
        error: error || 'none',
        error_description: error_description || 'none'
    });
    
    // Frontend URL to redirect to after auth
    // Default to vitals dashboard page
    const frontendUrl = 'http://localhost:5173/vitals';
    
    if (error) {
        const errorHtml = `
            <html>
                <head>
                    <title>Authentication Failed</title>
                    <meta http-equiv="refresh" content="3;url=${frontendUrl}">
                </head>
                <body style="font-family: Arial; padding: 40px; text-align: center;">
                    <h1 style="color: red;">❌ Authentication Failed</h1>
                    <p>Error: ${error}</p>
                    <p>Description: ${error_description || 'No description'}</p>
                    <p>Redirecting to dashboard...</p>
                </body>
            </html>
        `;
        res.send(errorHtml);
        console.error('❌ Authentication error:', { error, error_description });
        return;
    }
    
    if (!code) {
        const errorHtml = `
            <html>
                <head>
                    <title>No Authorization Code</title>
                    <meta http-equiv="refresh" content="3;url=${frontendUrl}">
                </head>
                <body style="font-family: Arial; padding: 40px; text-align: center;">
                    <h1 style="color: orange;">⚠️ No Authorization Code</h1>
                    <p>The authentication didn't return an authorization code.</p>
                    <p>Redirecting to dashboard...</p>
                </body>
            </html>
        `;
        res.send(errorHtml);
        console.error('❌ No authorization code in callback');
        return;
    }
    
    // State from Vitals7 is cognito user id; otherwise use config.state
    const cognitoUserId = state || config.state;

    try {
        // Exchange code for tokens
        const timestamp = getCurrentTimestamp();
        const nonce = await getNonce(timestamp);

        const params = {
            action: 'requesttoken',
            client_id: config.client_id,
            redirect_uri: getWithingsRedirectUri(),
            code: code,
            grant_type: 'authorization_code',
            nonce: nonce
        };

        params.signature = sign(params);

        console.log('🔄 Exchanging authorization code for tokens...');
        const response = await axios.post(`${config.api_endpoint}/v2/oauth2`, params);

        if (response.data && response.data.status === 0 && response.data.body) {
            const { userid, access_token, refresh_token, scope, expires_in, csrf_token, token_type } = response.data.body;

            console.log('✅ Authentication successful!');
            console.log(`👤 Withings User ID: ${userid}`);

            try {
                await dynamodb.saveTokens({
                    UserID: cognitoUserId,
                    AccessToken: access_token,
                    RefreshToken: refresh_token || '',
                    Expires: expires_in || 10800,
                    APIName: 'Withings',
                    token_type: 'bearer',
                    WithingsUserid: String(userid),
                });
            } catch (dbErr) {
                const msg = dbErr.message || String(dbErr);
                const isMissingTable =
                    /Requested resource not found|ResourceNotFoundException/i.test(msg) ||
                    /Cannot do operations on a non-existent table/i.test(msg);
                console.error('❌ DynamoDB saveTokens failed:', msg);
                if (isMissingTable) {
                    console.error(
                        `   Create ${process.env.TOKENS_TABLE || 'vitals-di-tokens'} in ${process.env.AWS_REGION || 'us-east-1'}, or restart the server (auto-create runs on startup unless AUTO_CREATE_DYNAMODB_TABLES=false).`
                    );
                }
                throw new Error(isMissingTable ? `DynamoDB: token table missing or wrong region — ${msg}` : msg);
            }

            // Send response immediately so browser does not retry (avoids 503 on code reuse)
            const successHtml = buildSuccessHtml();
            res.send(successHtml);

            // Fetch data and push to Vitals7 in background (same as iHealth sync flow)
            setImmediate(async () => {
                try {
                    tokenManager.setTokens({
                        userid,
                        access_token,
                        refresh_token: refresh_token || '',
                        cognitoUserId,
                        access_token_timestamp: getCurrentTimestamp(),
                        refresh_token_timestamp: getCurrentTimestamp(),
                    });
                    const withingsData = await withingsAPI.getAllData();
                    await syncWithingsToUserVitals(bareCognitoForWithings(cognitoUserId), withingsData);
                    const hookUrl = resolveWithingsWebhookUrl();
                    if (hookUrl) {
                        const sub = await subscribeAllForAccessToken(access_token, hookUrl);
                        if (!sub.skipped) {
                            const okCount = (sub.results || []).filter((r) => r.ok).length;
                            console.log(`Withings push notifications: ${okCount}/${(sub.results || []).length} appli subscribed → ${hookUrl}`);
                        }
                    } else {
                        console.warn('Set WITHINGS_WEBHOOK_URL (or PUBLIC_WEBHOOK_BASE_URL) to auto-subscribe for new readings.');
                    }
                } catch (err) {
                    console.warn('Background fetch/save failed:', err.message);
                }
            });
        } else {
            throw new Error(`API Error ${response.data?.status}: ${response.data?.body?.error || 'No error message'}`);
        }
    } catch (error) {
        const errorHtml = `
            <html>
                <head>
                    <title>Connection Failed</title>
                    <meta http-equiv="refresh" content="3;url=${frontendUrl}">
                </head>
                <body style="font-family: Arial; padding: 40px; text-align: center;">
                    <h1 style="color: red;">❌ Connection Failed</h1>
                    <p>Withings sign-in or saving tokens failed.</p>
                    <p>Redirecting to dashboard...</p>
                </body>
            </html>
        `;
        res.send(errorHtml);
        console.error('❌ OAuth / DynamoDB callback error:', error.message);
    }
});

// Documentation endpoint (same as in auth.js)
app.get('/docs', (req, res) => {
    res.send(getDocumentationHTML());
});

function getDocumentationHTML() {
    return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Withings API Documentation</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: #333;
            line-height: 1.6;
            padding: 20px;
        }
        
        .container {
            max-width: 1200px;
            margin: 0 auto;
            background: white;
            border-radius: 12px;
            box-shadow: 0 10px 40px rgba(0,0,0,0.1);
            overflow: hidden;
        }
        
        .header {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 40px;
            text-align: center;
        }
        
        .header h1 {
            font-size: 2.5em;
            margin-bottom: 10px;
        }
        
        .header p {
            font-size: 1.1em;
            opacity: 0.9;
        }
        
        .content {
            padding: 40px;
        }
        
        .section {
            margin-bottom: 40px;
        }
        
        .section h2 {
            color: #667eea;
            font-size: 1.8em;
            margin-bottom: 20px;
            padding-bottom: 10px;
            border-bottom: 2px solid #e0e0e0;
        }
        
        .section h3 {
            color: #764ba2;
            font-size: 1.3em;
            margin-top: 25px;
            margin-bottom: 15px;
        }
        
        .endpoint {
            background: #f8f9fa;
            border-left: 4px solid #667eea;
            padding: 20px;
            margin-bottom: 20px;
            border-radius: 4px;
        }
        
        .method {
            display: inline-block;
            padding: 5px 12px;
            border-radius: 4px;
            font-weight: bold;
            font-size: 0.9em;
            margin-right: 10px;
        }
        
        .method.get {
            background: #28a745;
            color: white;
        }
        
        .method.post {
            background: #007bff;
            color: white;
        }
        
        .endpoint-url {
            font-family: 'Courier New', monospace;
            font-size: 1.1em;
            color: #333;
            font-weight: bold;
        }
        
        .description {
            margin-top: 10px;
            color: #666;
        }
        
        .params {
            margin-top: 15px;
        }
        
        .params table {
            width: 100%;
            border-collapse: collapse;
            margin-top: 10px;
        }
        
        .params th,
        .params td {
            padding: 10px;
            text-align: left;
            border-bottom: 1px solid #e0e0e0;
        }
        
        .params th {
            background: #f8f9fa;
            font-weight: bold;
            color: #333;
        }
        
        .code-block {
            background: #2d2d2d;
            color: #f8f8f2;
            padding: 20px;
            border-radius: 6px;
            overflow-x: auto;
            margin-top: 15px;
            font-family: 'Courier New', monospace;
            font-size: 0.9em;
        }
        
        .code-block pre {
            margin: 0;
        }
        
        .badge {
            display: inline-block;
            padding: 4px 8px;
            border-radius: 4px;
            font-size: 0.8em;
            font-weight: bold;
            margin-left: 10px;
        }
        
        .badge.required {
            background: #dc3545;
            color: white;
        }
        
        .badge.optional {
            background: #ffc107;
            color: #333;
        }
        
        .response-example {
            margin-top: 15px;
        }
        
        .info-box {
            background: #e7f3ff;
            border-left: 4px solid #2196F3;
            padding: 15px;
            margin: 20px 0;
            border-radius: 4px;
        }
        
        .warning-box {
            background: #fff3cd;
            border-left: 4px solid #ffc107;
            padding: 15px;
            margin: 20px 0;
            border-radius: 4px;
        }
        
        .success-box {
            background: #d4edda;
            border-left: 4px solid #28a745;
            padding: 15px;
            margin: 20px 0;
            border-radius: 4px;
        }
        
        .toc {
            background: #f8f9fa;
            padding: 20px;
            border-radius: 8px;
            margin-bottom: 30px;
        }
        
        .toc h3 {
            margin-bottom: 15px;
            color: #667eea;
        }
        
        .toc ul {
            list-style: none;
            padding-left: 0;
        }
        
        .toc li {
            margin: 8px 0;
        }
        
        .toc a {
            color: #667eea;
            text-decoration: none;
            transition: color 0.3s;
        }
        
        .toc a:hover {
            color: #764ba2;
            text-decoration: underline;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>📚 Withings API Documentation</h1>
            <p>Complete API reference for Withings Health Data Integration</p>
        </div>
        
        <div class="content">
            <div class="toc">
                <h3>Table of Contents</h3>
                <ul>
                    <li><a href="#overview">Overview</a></li>
                    <li><a href="#authentication">Authentication</a></li>
                    <li><a href="#endpoints">API Endpoints</a></li>
                    <li><a href="#examples">Examples</a></li>
                </ul>
            </div>
            
            <div class="section" id="overview">
                <h2>📖 Overview</h2>
                <p>This API provides access to Withings health data including measurements, activity, sleep, and device information.</p>
                <div class="info-box">
                    <strong>Base URL:</strong> <code>http://localhost:5001</code><br>
                    <strong>API Version:</strong> v1<br>
                    <strong>Server Status:</strong> <span style="color: #28a745;">● Running</span>
                </div>
            </div>
            
            <div class="section" id="authentication">
                <h2>🔐 Authentication</h2>
                <p>This API uses OAuth 2.0 authentication flow with Withings. You must authenticate before accessing protected endpoints.</p>
                
                <div class="endpoint">
                    <span class="method get">GET</span>
                    <span class="endpoint-url">/api/status</span>
                    <div class="description">
                        Check authentication status and token information.
                    </div>
                    <div class="response-example">
                        <strong>Response (200 OK):</strong>
                        <div class="code-block">
<pre>{
  "authenticated": true,
  "userid": "12345678",
  "access_token_preview": "abc123def456...",
  "token_age_minutes": 45,
  "expires_in_minutes": 135,
  "last_sync": "2026-02-10T12:00:00.000Z",
  "last_data_fetch": "2026-02-10T12:00:00.000Z"
}</pre>
                        </div>
                    </div>
                </div>
                
                <div class="warning-box">
                    <strong>⚠️ Authentication Required:</strong> Most endpoints require valid authentication tokens. Use the authentication flow to obtain tokens.
                </div>
            </div>
            
            <div class="section" id="endpoints">
                <h2>🔌 API Endpoints</h2>
                
                <h3>Root Endpoint</h3>
                <div class="endpoint">
                    <span class="method get">GET</span>
                    <span class="endpoint-url">/</span>
                    <div class="description">
                        Server home page. Displays server status and information.
                    </div>
                </div>
                
                <h3>Documentation</h3>
                <div class="endpoint">
                    <span class="method get">GET</span>
                    <span class="endpoint-url">/docs</span>
                    <div class="description">
                        This documentation page. Provides complete API reference.
                    </div>
                </div>
                
                <h3>OAuth Callback</h3>
                <div class="endpoint">
                    <span class="method get">GET</span>
                    <span class="endpoint-url">/callback</span>
                    <div class="description">
                        OAuth 2.0 callback endpoint. Handles authorization code exchange.
                    </div>
                    <div class="params">
                        <strong>Query Parameters:</strong>
                        <table>
                            <tr>
                                <th>Parameter</th>
                                <th>Type</th>
                                <th>Required</th>
                                <th>Description</th>
                            </tr>
                            <tr>
                                <td><code>code</code></td>
                                <td>string</td>
                                <td><span class="badge required">Required</span></td>
                                <td>Authorization code from Withings</td>
                            </tr>
                            <tr>
                                <td><code>state</code></td>
                                <td>string</td>
                                <td><span class="badge required">Required</span></td>
                                <td>State parameter for CSRF protection</td>
                            </tr>
                            <tr>
                                <td><code>error</code></td>
                                <td>string</td>
                                <td><span class="badge optional">Optional</span></td>
                                <td>Error code if authentication failed</td>
                            </tr>
                        </table>
                    </div>
                </div>
                
                <h3>Push notifications (continuous sync)</h3>
                <p>Set <code>WITHINGS_WEBHOOK_URL</code> to your <strong>public HTTPS</strong> URL. Withings only <code>POST</code>s after <strong>successful subscribe</strong> (JSON <code>status: 0</code> per category); until then your webhook receives nothing.</p>
                <ul style="margin:12px 0 12px 20px;color:#555">
                    <li><strong>Path:</strong> this server exposes <code>/webhook/withings</code> (not <code>/withings/webhook</code>).</li>
                    <li><strong>Developer Portal:</strong> allowlist the <em>exact</em> callback URL (same string as <code>WITHINGS_WEBHOOK_URL</code>), HTTPS.</li>
                    <li><strong>Subscribe API URL:</strong> default is <code>https://wbsapi.withings.net/notify</code>. Do <strong>not</strong> set <code>WITHINGS_NOTIFY_USE_V2=1</code> on Render unless Withings requires it; <code>/v2/notify</code> often returns <code>Insufficient_scope</code> for Public API.</li>
                    <li><strong>How to subscribe:</strong> complete OAuth again (auto-subscribe after callback), or call <code>POST /api/withings/register-webhooks</code> with <code>cognitoUserId</code> (see example below). Confirm logs: <code>Withings notify subscribed appli=…</code>.</li>
                    <li><strong>Realtime gateway:</strong> optional — set <code>VITALS_REALTIME_GATEWAY_URL</code> and <code>VITALS_REALTIME_GATEWAY_SECRET</code> or ignore the gateway publish warning; it does not affect Withings webhooks or DynamoDB sync.</li>
                </ul>
                <p>After each successful OAuth, the server subscribes to Withings data categories (weight, activity, sleep, …). New cloud data triggers <code>POST /webhook/withings</code>, which runs the same sync as <code>POST /api/withings/sync</code> and writes to <code>user_vitals</code>.</p>
                <div class="endpoint">
                    <span class="method get">GET</span>
                    <span class="method head">HEAD</span>
                    <span class="endpoint-url">/webhook/withings</span>
                    <div class="description">Health check for Withings / load balancers (200 OK).</div>
                </div>
                <div class="endpoint">
                    <span class="method post">POST</span>
                    <span class="endpoint-url">/webhook/withings</span>
                    <div class="description">Withings notification (<code>application/x-www-form-urlencoded</code>). Body includes <code>userid</code>, <code>appli</code>, optional <code>startdate</code>/<code>enddate</code>.</div>
                </div>
                <div class="endpoint">
                    <span class="method post">POST</span>
                    <span class="endpoint-url">/api/withings/register-webhooks</span>
                    <div class="description">Re-subscribe using stored tokens (optional JSON body <code>cognitoUserId</code>). Requires <code>WITHINGS_WEBHOOK_URL</code> env.</div>
                </div>
            </div>
            
            <div class="section" id="examples">
                <h2>💡 Usage Examples</h2>
                
                <h3>Check Authentication Status</h3>
                <div class="code-block">
<pre>curl http://localhost:5001/api/status</pre>
                </div>
                
                <h3>Re-register Withings push subscriptions</h3>
                <p>After fixing env (e.g. unset <code>WITHINGS_NOTIFY_USE_V2</code>), call with the Vitals7 user id (Cognito sub):</p>
                <div class="code-block">
<pre>curl -sS -X POST "http://localhost:5001/api/withings/register-webhooks" \\
  -H "Content-Type: application/json" \\
  -d '{"cognitoUserId":"YOUR_COGNITO_SUB_UUID"}'</pre>
                </div>
                
                <h3>View Documentation</h3>
                <div class="code-block">
<pre># Open in browser
http://localhost:5001/docs

# Or use curl
curl http://localhost:5001/docs</pre>
                </div>
                
                <div class="info-box">
                    <strong>💡 Tip:</strong> Use the interactive menu by running <code>npm start</code> for easier access to all features.
                </div>
            </div>
            
            <div class="section">
                <h2>📝 CLI (optional)</h2>
                <div class="code-block">
<pre># Interactive menu
npm start

# Authenticate (standalone script — prefer Vitals7 + server /login)
npm run auth

# Sync Withings → DynamoDB user_vitals (tokens must exist in vitals-di-tokens)
COGNITO_USER_ID=&lt;uuid&gt; npm run get-data
# or
node src/data/save-data.js &lt;uuid&gt;

# Check status
npm run status</pre>
                </div>
                <p style="margin-top:12px">Health data is not written to local JSON. Tokens: <code>vitals-di-tokens</code>. Readings: <code>user_vitals</code>. Use <code>POST /api/withings/sync</code> from the app when possible.</p>
            </div>
            
            <div class="section">
                <h2>🔗 Related Resources</h2>
                <ul style="list-style: none; padding-left: 0;">
                    <li>📖 <a href="https://developer.withings.com/api-reference" target="_blank">Withings Official API Documentation</a></li>
                    <li>🔐 <a href="https://account.withings.com/oauth2_user/authorize2" target="_blank">Withings OAuth Portal</a></li>
                    <li>📊 <a href="https://healthmate.withings.com" target="_blank">Withings Health Mate</a></li>
                </ul>
            </div>
        </div>
    </div>
</body>
</html>
    `;
}

// Root endpoint
app.get('/', (req, res) => {
    res.send(`
        <html>
            <head>
                <title>Withings API Server</title>
                <style>
                    body { 
                        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                        padding: 40px; 
                        text-align: center;
                        background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                        color: white;
                        min-height: 100vh;
                        display: flex;
                        flex-direction: column;
                        justify-content: center;
                        align-items: center;
                    }
                    .container {
                        background: rgba(255, 255, 255, 0.1);
                        padding: 40px;
                        border-radius: 20px;
                        backdrop-filter: blur(10px);
                    }
                    h1 { color: white; margin-bottom: 20px; }
                    a {
                        color: white;
                        text-decoration: underline;
                        font-size: 1.2em;
                        margin: 10px;
                        display: inline-block;
                    }
                    a:hover {
                        text-decoration: none;
                    }
                </style>
            </head>
            <body>
                <div class="container">
                    <h1>🏥 Withings API Server</h1>
                    <p>Server is running on port ${PORT}</p>
                    <div style="margin-top: 30px;">
                        <a href="/docs">📚 View API Documentation</a>
                        <a href="/api/status">📊 Check Status</a>
                    </div>
                </div>
            </body>
        </html>
    `);
});

// Start server (ensure DynamoDB tables so OAuth callback saveTokens does not fail)
(async () => {
    try {
        await ensureVitalsDiTables();
    } catch (e) {
        console.warn('⚠️ DynamoDB ensure-tables skipped or failed:', e.message);
    }
    const server = app.listen(PORT, () => {
        console.log(`\n🚀 Withings API Server running on http://localhost:${PORT}`);
        console.log(`📚 Documentation available at http://localhost:${PORT}/docs`);
        console.log(`📊 Status endpoint: http://localhost:${PORT}/api/status`);
        const hookBanner = resolveWithingsWebhookUrl();
        if (!hookBanner) {
            console.log(`ℹ️  Set WITHINGS_WEBHOOK_URL (or PUBLIC_WEBHOOK_BASE_URL) for Withings push → user_vitals after OAuth.`);
        } else {
            console.log(`🔔 Withings webhook URL: ${hookBanner}`);
        }
        const notifyUrl = getNotifyApiUrl();
        console.log(`📮 Withings notify API (subscribe POST): ${notifyUrl}`);
        if (/\/v2\/notify$/i.test(String(notifyUrl).replace(/\/$/, ''))) {
            console.warn(
                '⚠️  Notify subscribe uses /v2/notify — Public API tokens often get Insufficient_scope (403). Unset WITHINGS_NOTIFY_USE_V2 on Render unless Withings requires v2; default is https://wbsapi.withings.net/notify'
            );
        }
        console.log(`\nPress Ctrl+C to stop the server\n`);
    });

    process.on('SIGINT', () => {
        console.log('\n👋 Shutting down server...');
        server.close(() => {
            console.log('✅ Server closed');
            process.exit(0);
        });
    });

    process.on('SIGTERM', () => {
        server.close(() => {
            process.exit(0);
        });
    });
})();

