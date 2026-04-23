const axios = require('axios');
const express = require('express');
const config = require('../config.json');
const tokenManager = require('./utils/token-manager');
const crypto = require('crypto');

const app = express();
const PORT = 5001;

// Simple signature function
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
        console.log('🔧 Getting nonce...');
        const params = {
            action: 'getnonce',
            client_id: config.client_id,
            timestamp: timestamp
        };
        
        params.signature = sign(params);
        
        console.log('Requesting nonce with:', {
            url: `${config.api_endpoint}/v2/signature`,
            params: {
                ...params,
                client_id: `${params.client_id.substring(0, 10)}...`
            }
        });
        
        const response = await axios.post(`${config.api_endpoint}/v2/signature`, params);
        console.log('✅ Nonce received:', response.data.body.nonce);
        return response.data.body.nonce;
    } catch (error) {
        console.error('❌ Error getting nonce:');
        if (error.response) {
            console.error('Response status:', error.response.status);
            console.error('Response data:', error.response.data);
        } else {
            console.error('Error message:', error.message);
        }
        throw error;
    }
}

async function exchangeCodeForTokens(authorizationCode) {
    try {
        console.log('🔄 Exchanging authorization code for tokens...');
        const timestamp = getCurrentTimestamp();
        const nonce = await getNonce(timestamp);
        
        // CORRECT PARAMS: Do NOT include 'timestamp' for requesttoken
        const params = {
            action: 'requesttoken',
            client_id: config.client_id,
            redirect_uri: config.redirect_uri,
            code: authorizationCode,
            grant_type: 'authorization_code',
            nonce: nonce
            // timestamp: timestamp  <-- REMOVE THIS LINE
        };
        
        params.signature = sign(params);
        
        console.log('Requesting tokens with params (timestamp excluded):', {
            ...params,
            client_id: `${params.client_id.substring(0, 10)}...`,
            code: `${authorizationCode.substring(0, 10)}...`
        });
        
        const response = await axios.post(`${config.api_endpoint}/v2/oauth2`, params);
        
        // LOG THE FULL RESPONSE FOR DEBUGGING
        console.log('Full API Response:', JSON.stringify(response.data, null, 2));
        
        // Check if response has the expected structure
        if (response.data && response.data.status === 0 && response.data.body) {
            const { userid, access_token, refresh_token, scope, expires_in, csrf_token, token_type } = response.data.body;
            
            if (!access_token) {
                throw new Error('API response did not contain an access_token');
            }
            
            const tokens = {
                userid,
                access_token,
                refresh_token,
                scope,
                expires_in,
                csrf_token,
                token_type,
                access_token_timestamp: getCurrentTimestamp(), // Store when we got it
                refresh_token_timestamp: getCurrentTimestamp(),
                last_sync: new Date().toISOString()
            };
            
            tokenManager.updateTokens(tokens);
            console.log('✅ Authentication successful!');
            console.log(`👤 User ID: ${userid}`);
            console.log(`🔑 Access Token: ${access_token.substring(0, 20)}...`);
            console.log('Tokens updated in memory; use the Withings server OAuth flow to persist to DynamoDB (vitals-di-tokens).');
            
            return tokens;
        } else {
            // Handle API error response
            console.error('❌ API returned an error:');
            console.error('Status:', response.data?.status);
            console.error('Error:', response.data?.body?.error || 'Unknown error');
            throw new Error(`API Error ${response.data?.status}: ${response.data?.body?.error || 'No error message'}`);
        }
        
    } catch (error) {
        console.error('❌ Error exchanging code for tokens:');
        if (error.response) {
            console.error('HTTP Status:', error.response.status);
            console.error('Response Data:', JSON.stringify(error.response.data, null, 2));
        } else {
            console.error('Error message:', error.message);
        }
        throw error;
    }
}

// Middleware for JSON parsing
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// API Routes
app.get('/api/status', (req, res) => {
    const tokens = tokenManager.getTokens();
    if (tokens.access_token) {
        const now = Math.floor(Date.now() / 1000);
        const age = tokens.access_token_timestamp ? now - tokens.access_token_timestamp : 0;
        const expiresIn = 10800 - age; // 3 hours in seconds
        
        res.json({
            authenticated: true,
            userid: tokens.userid,
            access_token_preview: tokens.access_token.substring(0, 20) + '...',
            token_age_minutes: Math.floor(age / 60),
            expires_in_minutes: Math.floor(expiresIn / 60),
            last_sync: tokens.last_sync || 'Never',
            last_data_fetch: tokens.last_data_fetch || 'Never'
        });
    } else {
        res.json({
            authenticated: false,
            message: 'Not authenticated. Please authenticate first.'
        });
    }
});

// Documentation endpoint
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
            </div>
            
            <div class="section" id="examples">
                <h2>💡 Usage Examples</h2>
                
                <h3>Check Authentication Status</h3>
                <div class="code-block">
<pre>curl http://localhost:5001/api/status</pre>
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
                <h2>📝 Available Commands</h2>
                <div class="code-block">
<pre># Interactive menu
npm start

# Authenticate
npm run auth
# or
node src/index.js auth

# Sync to DynamoDB user_vitals (needs COGNITO_USER_ID or uuid arg)
COGNITO_USER_ID=<uuid> npm run get-data

# Check status
npm run status
# or
node src/index.js status</pre>
                </div>
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

function startAuthServer() {
    app.get('/', (req, res) => {
        res.send(`
            <html>
                <head>
                    <title>Withings Auth</title>
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
                        <h1>🏥 Withings Authentication Server</h1>
                        <p>Server is running on port ${PORT}</p>
                        <p>Waiting for authentication callback...</p>
                        <div style="margin-top: 30px;">
                            <a href="/docs">📚 View API Documentation</a>
                            <a href="/api/status">📊 Check Status</a>
                        </div>
                    </div>
                </body>
            </html>
        `);
    });

    app.get('/callback', async (req, res) => {
        const { code, state, error, error_description } = req.query;
        
        console.log('\n📥 Callback received:', {
            code: code ? `${code.substring(0, 10)}...` : 'none',
            state: state || 'none',
            error: error || 'none',
            error_description: error_description || 'none'
        });
        
        if (error) {
            const errorHtml = `
                <html>
                    <head><title>Authentication Failed</title></head>
                    <body style="font-family: Arial; padding: 40px; text-align: center;">
                        <h1 style="color: red;">❌ Authentication Failed</h1>
                        <p>Error: ${error}</p>
                        <p>Description: ${error_description || 'No description'}</p>
                        <p>Check the terminal for more details.</p>
                    </body>
                </html>
            `;
            res.send(errorHtml);
            console.error('❌ Authentication error:', { error, error_description });
            setTimeout(() => process.exit(1), 2000);
            return;
        }
        
        if (!code) {
            res.send(`
                <html>
                    <body style="font-family: Arial; padding: 40px; text-align: center;">
                        <h1 style="color: orange;">⚠️ No Authorization Code</h1>
                        <p>The authentication didn't return an authorization code.</p>
                        <p>Check the URL parameters and try again.</p>
                    </body>
                </html>
            `);
            console.error('❌ No authorization code in callback');
            setTimeout(() => process.exit(1), 2000);
            return;
        }
        
        if (state !== config.state) {
            res.send(`
                <html>
                    <body style="font-family: Arial; padding: 40px; text-align: center;">
                        <h1 style="color: orange;">⚠️ State Mismatch</h1>
                        <p>Received state: ${state}</p>
                        <p>Expected state: ${config.state}</p>
                        <p>Possible CSRF attack or session issue.</p>
                    </body>
                </html>
            `);
            console.error('❌ State mismatch:', state, 'expected:', config.state);
            setTimeout(() => process.exit(1), 2000);
            return;
        }
        
        try {
            await exchangeCodeForTokens(code);
            
            const successHtml = `
                <html>
                    <head>
                        <title>Authentication Successful</title>
                        <style>
                            body {
                                font-family: Arial, sans-serif;
                                text-align: center;
                                padding: 50px;
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
                                box-shadow: 0 8px 32px rgba(0, 0, 0, 0.1);
                            }
                            h1 {
                                font-size: 3em;
                                margin-bottom: 20px;
                            }
                            .checkmark {
                                font-size: 4em;
                                margin-bottom: 20px;
                            }
                            p {
                                font-size: 1.2em;
                                margin-bottom: 30px;
                                opacity: 0.9;
                            }
                        </style>
                    </head>
                    <body>
                        <div class="container">
                            <div class="checkmark">✅</div>
                            <h1>Authentication Successful!</h1>
                            <p>You can now close this window and return to the terminal.</p>
                            <p>Tokens are in memory for this CLI session. Use the Vitals7 server OAuth flow to store tokens in DynamoDB (vitals-di-tokens).</p>
                        </div>
                        <script>
                            setTimeout(() => {
                                window.close();
                            }, 3000);
                        </script>
                    </body>
                </html>
            `;
            res.send(successHtml);
            
            console.log('\n✅ Authentication completed successfully!');
            console.log('For Vitals7: use the Withings server (/login) so tokens are saved to vitals-di-tokens.');
            console.log('Optional CLI sync: COGNITO_USER_ID=<uuid> npm run get-data');
            
            setTimeout(() => {
                console.log('\n👋 Shutting down authentication server...');
                process.exit(0);
            }, 3000);
            
        } catch (error) {
            const errorHtml = `
                <html>
                    <body style="font-family: Arial; padding: 40px; text-align: center;">
                        <h1 style="color: red;">❌ Token Exchange Failed</h1>
                        <p>Failed to exchange authorization code for tokens.</p>
                        <p>Check the terminal for detailed error messages.</p>
                    </body>
                </html>
            `;
            res.send(errorHtml);
            console.error('❌ Token exchange failed:', error.message);
            setTimeout(() => process.exit(1), 2000);
        }
    });
    
    return new Promise((resolve) => {
        const server = app.listen(PORT, () => {
            console.log(`✅ Callback server running on http://localhost:${PORT}`);
            console.log(`✅ Ready to receive authentication callback`);
            resolve(server);
        });
    });
}

async function initiateAuth() {
    try {
        console.log('🚀 Starting Withings Authentication');
        console.log('====================================');
        console.log('📋 Configuration:');
        console.log(`   Client ID: ${config.client_id.substring(0, 10)}...`);
        console.log(`   Redirect URI: ${config.redirect_uri}`);
        console.log(`   Scopes: ${config.scopes}`);
        console.log(`   State: ${config.state}`);
        
        // First, test if we can get a nonce (API connectivity test)
        console.log('\n🔧 Testing API connectivity...');
        try {
            const testTimestamp = getCurrentTimestamp();
            const testNonce = await getNonce(testTimestamp);
            console.log('✅ API connectivity test passed!');
        } catch (error) {
            console.error('❌ API connectivity test failed!');
            console.error('Please check:');
            console.error('1. Your Client ID and Secret in config.json');
            console.error('2. Your internet connection');
            console.error('3. Withings API status (https://status.withings.com)');
            process.exit(1);
        }
        
        // Build the authorization URL
        const authUrl = new URL(config.auth_url);
        authUrl.searchParams.append('response_type', 'code');
        authUrl.searchParams.append('client_id', config.client_id);
        authUrl.searchParams.append('scope', config.scopes);
        authUrl.searchParams.append('redirect_uri', config.redirect_uri);
        authUrl.searchParams.append('state', config.state);
        
        console.log('\n🌐 Please visit this URL in your browser:');
        console.log('\n' + '='.repeat(80));
        console.log(authUrl.toString());
        console.log('='.repeat(80) + '\n');
        
        console.log('📝 You will need to:');
        console.log('   1. Log in to your Withings account (if not already logged in)');
        console.log('   2. Review the permissions requested');
        console.log('   3. Click "Allow" to authorize the application');
        console.log('   4. Wait to be redirected back to localhost:5001/callback');
        
        // Start the callback server
        console.log('\n⏳ Waiting for authentication callback...');
        await startAuthServer();
        
    } catch (error) {
        console.error('❌ Authentication initiation failed:');
        console.error(error.message);
        if (error.code === 'EADDRINUSE') {
            console.error(`Port ${PORT} is already in use.`);
            console.error('Another application might be using port 5001.');
            console.error('You can either:');
            console.error('1. Change the port in config.json and Withings dashboard');
            console.error('2. Stop the application using port 5001');
        }
        process.exit(1);
    }
}

module.exports = {
    initiateAuth,
    exchangeCodeForTokens
};