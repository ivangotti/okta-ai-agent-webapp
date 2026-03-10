import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { readFileSync } from 'fs';

// Configuration (per SDK)
const OKTA_DOMAIN = 'https://blackcastle.oktapreview.com';
const ORG_TOKEN_ENDPOINT = `${OKTA_DOMAIN}/oauth2/v1/token`;  // ORG level per SDK
const CUSTOM_AUTH_SERVER = 'https://blackcastle.oktapreview.com/oauth2/aus2o8ra5nfzluTlI0h8';
const AGENT_CLIENT_ID = 'wlp2o86e2kkTN0tuS0h8';

// User's tokens from DEFAULT auth server (FRESH)
const USER_ID_TOKEN = 'eyJraWQiOiJJeDk3NkdqbWM5d09Ud29JNDVYUTZpSUpmUmdTbEI1V05BZ3c0V19NVFk4IiwiYWxnIjoiUlMyNTYifQ.eyJzdWIiOiIwMHVwb3J1eGV1T2tZeHA5RTBoNyIsIm5hbWUiOiJJdmFuIEdvdHRpIiwiZW1haWwiOiJpdmFuLmdvdHRpQG9rdGEuY29tIiwidmVyIjoxLCJpc3MiOiJodHRwczovL2JsYWNrY2FzdGxlLm9rdGFwcmV2aWV3LmNvbS9vYXV0aDIvZGVmYXVsdCIsImF1ZCI6IjBvYTJvOHJjaHc4QnZ2a0VBMGg4IiwiaWF0IjoxNzczMDk2NjczLCJleHAiOjE3NzMxMDAyNzMsImp0aSI6IklELlM4QU5KX0o0WVhURl81cXMzOVJENFNkUVMwWUx3aDZsMUx4bWx4amVsT1kiLCJhbXIiOlsibWZhIiwicHdkIiwidXNlciIsImh3ayJdLCJpZHAiOiIwMG9wb3J1eGRnMUlub203ZzBoNyIsInByZWZlcnJlZF91c2VybmFtZSI6Iml2YW4uZ290dGlAb2t0YS5jb20iLCJhdXRoX3RpbWUiOjE3NzMwOTI2NzUsImF0X2hhc2giOiJGN0p2SGtQbkQtNm1lR1M3emF5bEFBIn0.fnIrSkWa0omqCqBs9h96JKC4P3mA6ZdvDbILKNwTmLCtmeFIUs1lWlYPq-3hN-bkRVHUV_cBHSITIEsfN9GO39qUTdqT5DwUb2fjz_1bBcy7cLD1u8L5wehSRAGtQUUzoCQcYa1Z13O5NwvNUGTftzO3D787M6VXoChPO82QXVXwb48PZre1veS0SIQEzmdTlIbTRDP-ey2Dh7Dx9H9qnWOdtd4NrO2aKlw9E7W9sTg0S2JP8To83FOtBYHhCGpH9DuL2AsvX0xbYMiAlqhxdo7pJB7m8bv8_UQ_YADmoTU37ZzHRPP6tFq-wqo3T_V0I2iO4Wwj6t9aVXLDwARZEg';
const USER_ACCESS_TOKEN = 'eyJraWQiOiJJeDk3NkdqbWM5d09Ud29JNDVYUTZpSUpmUmdTbEI1V05BZ3c0V19NVFk4IiwiYWxnIjoiUlMyNTYifQ.eyJ2ZXIiOjEsImp0aSI6IkFULnphWEdYemdHaWJ2UWo5aHhuLXZBWHQtNUY3SGUyeGpMR1FTa1BHeGdOczAiLCJpc3MiOiJodHRwczovL2JsYWNrY2FzdGxlLm9rdGFwcmV2aWV3LmNvbS9vYXV0aDIvZGVmYXVsdCIsImF1ZCI6ImFwaTovL2RlZmF1bHQiLCJpYXQiOjE3NzMwOTY2NzMsImV4cCI6MTc3MzEwMDI3MywiY2lkIjoiMG9hMm84cmNodzhCdnZrRUEwaDgiLCJ1aWQiOiIwMHVwb3J1eGV1T2tZeHA5RTBoNyIsInNjcCI6WyJlbWFpbCIsIm9wZW5pZCIsInByb2ZpbGUiXSwiYXV0aF90aW1lIjoxNzczMDkyNjc1LCJzdWIiOiJpdmFuLmdvdHRpQG9rdGEuY29tIn0.MuAUNfplBKZ2B6Kpf5bwimowFvmjkBESkU_X2v0IO__hrpU_0DARlxdbEjUYaBAfjJe9iO_b0yDS-SfRowjde-4HRZmfweFGNVm2HwWAF6pR8pTM5jDpN3r3u40hnq8jpNHm3E4NyC6mHbRwWNgowsX-CA6va1XGA19S7f9o85UmzZ2cSxkGcYMl2HqgHKud-HWO8Y8QRJ1P6vevVgh-CPFqundXZx-YvDpZXE12onF_ojKhp1k_RSzJTDKQwVkmDmhoir50Q3Ds1-LsI6mminIoi2fpSU3V-2lXUSMIohLrY3AqUiYsOKB_S7YSbT537eBmt4p_IWCiihWiOTJuKQ';

// Load agent private key
const agentPrivateKey = JSON.parse(readFileSync('./agent-keys/agent-private-key.json', 'utf-8'));

// Convert JWK to PEM
function jwkToPem(jwk) {
  const keyObject = crypto.createPrivateKey({ key: jwk, format: 'jwk' });
  return keyObject.export({ type: 'pkcs8', format: 'pem' });
}

// Generate client assertion
function generateClientAssertion(clientId, tokenEndpoint) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: clientId,
    sub: clientId,
    aud: tokenEndpoint,
    iat: now,
    exp: now + 300,
    jti: crypto.randomUUID()
  };

  const privateKeyPem = jwkToPem(agentPrivateKey);

  return jwt.sign(payload, privateKeyPem, {
    algorithm: 'RS256',
    header: {
      alg: 'RS256',
      kid: agentPrivateKey.kid
    }
  });
}

// Test ID-JAG token exchange
async function testIdJagExchange() {
  console.log('='.repeat(70));
  console.log('TESTING ID-JAG TOKEN EXCHANGE (Agent ID Assertion)');
  console.log('='.repeat(70));
  console.log();

  // Generate client assertion for ORG server
  console.log('1. Generating client assertion...');
  const clientAssertion = generateClientAssertion(AGENT_CLIENT_ID, ORG_TOKEN_ENDPOINT);
  console.log('   ✓ Client assertion generated');
  console.log('   Agent Client ID:', AGENT_CLIENT_ID);
  console.log('   Key ID:', agentPrivateKey.kid);
  console.log();

  // Prepare token exchange request (exact SDK format)
  console.log('2. Preparing token exchange request (per SDK)...');
  const params = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
    requested_token_type: 'urn:ietf:params:oauth:token-type:id-jag',
    subject_token: USER_ID_TOKEN,
    subject_token_type: 'urn:ietf:params:oauth:token-type:id_token',
    audience: CUSTOM_AUTH_SERVER,
    scope: 'ask-nist-mcp',
    client_id: AGENT_CLIENT_ID,
    client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
    client_assertion: clientAssertion
  });

  console.log('   Endpoint:', ORG_TOKEN_ENDPOINT);
  console.log('   Parameters:');
  console.log('   - grant_type:', 'token-exchange');
  console.log('   - requested_token_type:', 'id-jag');
  console.log('   - scope:', 'ask-nist-mcp');
  console.log('   - audience:', CUSTOM_AUTH_SERVER);
  console.log('   - client_id:', AGENT_CLIENT_ID);
  console.log();

  // Make request
  console.log('3. Making request to Okta DEFAULT authorization server...');
  try {
    const response = await fetch(DEFAULT_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json'
      },
      body: params.toString()
    });

    const responseText = await response.text();
    console.log('   Response status:', response.status, response.statusText);
    console.log();

    if (!response.ok) {
      console.log('❌ TOKEN EXCHANGE FAILED');
      console.log('   Error response:', responseText);
      console.log();
      return;
    }

    const data = JSON.parse(responseText);
    console.log('✅ TOKEN EXCHANGE SUCCESSFUL!');
    console.log();
    console.log('Response:');
    console.log(JSON.stringify(data, null, 2));
    console.log();

    // Parse the token
    if (data.access_token) {
      const decoded = jwt.decode(data.access_token, { complete: true });
      console.log('ID-JAG Token Claims:');
      console.log(JSON.stringify(decoded.payload, null, 2));
    }

  } catch (error) {
    console.log('❌ REQUEST FAILED');
    console.log('   Error:', error.message);
  }
}

// Run test
testIdJagExchange();
