#!/bin/bash

# Fresh tokens from user
ID_TOKEN='eyJraWQiOiJJeDk3NkdqbWM5d09Ud29JNDVYUTZpSUpmUmdTbEI1V05BZ3c0V19NVFk4IiwiYWxnIjoiUlMyNTYifQ.eyJzdWIiOiIwMHVwb3J1eGV1T2tZeHA5RTBoNyIsIm5hbWUiOiJJdmFuIEdvdHRpIiwiZW1haWwiOiJpdmFuLmdvdHRpQG9rdGEuY29tIiwidmVyIjoxLCJpc3MiOiJodHRwczovL2JsYWNrY2FzdGxlLm9rdGFwcmV2aWV3LmNvbS9vYXV0aDIvZGVmYXVsdCIsImF1ZCI6IjBvYTJvOHJjaHc4QnZ2a0VBMGg4IiwiaWF0IjoxNzczMTAzODE4LCJleHAiOjE3NzMxMDc0MTgsImp0aSI6IklELnJBRTkyWmh6dW9PQ1YybFhiUDk3RWdHemx2TlZpOUhLdEpDYmYzc3hreGciLCJhbXIiOlsibWZhIiwicHdkIiwiaHdrIiwidXNlciJdLCJpZHAiOiIwMG9wb3J1eGRnMUlub203ZzBoNyIsInByZWZlcnJlZF91c2VybmFtZSI6Iml2YW4uZ290dGlAb2t0YS5jb20iLCJhdXRoX3RpbWUiOjE3NzMxMDM4MTcsImF0X2hhc2giOiJkVU13SFRKcENDUWlubjBkWm9PZTlRIn0.D1a7apk45m34VvYwlIczI9wCVyPAP_RstibM862W6aLHee4_yC4_qQa7TJLFIDj7s9oV-e3rWqU0gB-emxVy6ifxWXNFt2iUGhw_PTZYlxp43vaY8sqC2h5UXoDXz0A5mN2BAwCEA3p22LrRK2muJvEI5HzQKAzihl4-YPs2PUKI0QSl5QUixk5i4cku0XyWckXJmFZwAAYQJwFxYTjUWuIp0e2f-ggRIihJH3Ky0ASXr_itee3DR7VRq4Z3bvSBdJv5K6E3dtlh4gPu_JAcDEDIwC8wl75sSRPnifwFnhpSVn5rhznC5NmZmAGvm-hFeYRkLw3YcIhah-guUIGrLA'

# Generate client assertion
CLIENT_ASSERTION=$(node -e "
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const fs = require('fs');

const key = JSON.parse(fs.readFileSync('./agent-keys/agent-private-key.json', 'utf-8'));
const endpoint = 'https://blackcastle.oktapreview.com/oauth2/default/v1/token';
const clientId = 'wlp2o86e2kkTN0tuS0h8';

function jwkToPem(jwk) {
  const keyObject = crypto.createPrivateKey({ key: jwk, format: 'jwk' });
  return keyObject.export({ type: 'pkcs8', format: 'pem' });
}

const now = Math.floor(Date.now() / 1000);
const payload = {
  iss: clientId,
  sub: clientId,
  aud: endpoint,
  iat: now,
  exp: now + 300,
  jti: crypto.randomUUID()
};

const token = jwt.sign(payload, jwkToPem(key), {
  algorithm: 'RS256',
  header: { alg: 'RS256', kid: key.kid }
});

console.log(token);
")

echo "Test 1: With requested_token_type=id-jag"
echo "=========================================="
curl -s -X POST 'https://blackcastle.oktapreview.com/oauth2/default/v1/token' \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode "grant_type=urn:ietf:params:oauth:grant-type:token-exchange" \
  --data-urlencode "client_id=wlp2o86e2kkTN0tuS0h8" \
  --data-urlencode "subject_token=$ID_TOKEN" \
  --data-urlencode "subject_token_type=urn:ietf:params:oauth:token-type:id_token" \
  --data-urlencode "audience=https://blackcastle.oktapreview.com/oauth2/aus2o8ra5nfzluTlI0h8" \
  --data-urlencode "scope=ask-nist-mcp" \
  --data-urlencode "requested_token_type=urn:ietf:params:oauth:token-type:id-jag" \
  --data-urlencode "client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer" \
  --data-urlencode "client_assertion=$CLIENT_ASSERTION" \
  | jq '.'

echo ""
echo "Test 2: WITHOUT requested_token_type (let Okta decide)"
echo "========================================================"
curl -s -X POST 'https://blackcastle.oktapreview.com/oauth2/default/v1/token' \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode "grant_type=urn:ietf:params:oauth:grant-type:token-exchange" \
  --data-urlencode "client_id=wlp2o86e2kkTN0tuS0h8" \
  --data-urlencode "subject_token=$ID_TOKEN" \
  --data-urlencode "subject_token_type=urn:ietf:params:oauth:token-type:id_token" \
  --data-urlencode "audience=https://blackcastle.oktapreview.com/oauth2/aus2o8ra5nfzluTlI0h8" \
  --data-urlencode "scope=ask-nist-mcp" \
  --data-urlencode "client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer" \
  --data-urlencode "client_assertion=$CLIENT_ASSERTION" \
  | jq '.'
