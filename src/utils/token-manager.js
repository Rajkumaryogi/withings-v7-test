/**
 * In-memory token store only. Tokens are persisted in DynamoDB (vitals-di-tokens).
 * setTokens() is used after loading from DynamoDB or after OAuth callback so that
 * the Withings API module (getTokens()) can use the current user's tokens.
 */
class TokenManager {
  constructor() {
    this.memoryTokens = {};
  }

  getTokens() {
    return this.memoryTokens;
  }

  setTokens(tokens) {
    this.memoryTokens = tokens && typeof tokens === 'object' ? { ...tokens } : {};
    return this.memoryTokens;
  }

  clearTokens() {
    this.memoryTokens = {};
  }

    updateTokens(newTokens) {
    this.memoryTokens = { ...this.memoryTokens, ...newTokens };
    return this.memoryTokens;
  }

  isTokenExpired(accessTokenTimestamp) {
    if (!accessTokenTimestamp) return true;
    const now = Math.floor(Date.now() / 1000);
    const tokenAge = now - accessTokenTimestamp;
    return tokenAge >= 10800; // 3 hours
  }

  hasValidToken() {
    const tokens = this.getTokens();
    return !!(tokens.access_token && !this.isTokenExpired(tokens.access_token_timestamp));
  }
}

module.exports = new TokenManager();