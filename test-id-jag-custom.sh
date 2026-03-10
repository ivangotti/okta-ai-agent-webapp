#!/bin/bash

# Generate client assertion using Node
CLIENT_ASSERTION=$(node -e "
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const fs = require('fs');

const key = JSON.parse(fs.readFileSync('./agent-keys/agent-private-key.json', 'utf-8'));
const endpoint = 'https://blackcastle.oktapreview.com/oauth2/aus2o8ra5nfzluTlI0h8/v1/token';

function jwkToPem(jwk) {
  const keyObject = crypto.createPrivateKey({ key: jwk, format: 'jwk' });
  return keyObject.export({ type: 'pkcs8', format: 'pem' });
}

const now = Math.floor(Date.now() / 1000);
const payload = {
  iss: 'wlp2o86e2kkTN0tuS0h8',
  sub: 'wlp2o86e2kkTN0tuS0h8',
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

ID_TOKEN='eyJraWQiOiJSLWlNVWRrNnFPbUFBRHdjNENDZVVXbmZ6QURVMXpmVGJCXzFiQTJXR2JjIiwiYWxnIjoiUlMyNTYifQ.eyJzdWIiOiIwMHVwb3J1eGV1T2tZeHA5RTBoNyIsIm5hbWUiOiJJdmFuIEdvdHRpIiwiZW1haWwiOiJpdmFuLmdvdHRpQG9rdGEuY29tIiwidmVyIjoxLCJpc3MiOiJodHRwczovL2JsYWNrY2FzdGxlLm9rdGFwcmV2aWV3LmNvbS9vYXV0aDIvYXVzMm84cmE1bmZ6bHVUbEkwaDgiLCJhdWQiOiIwb2EybzhyY2h3OEJ2dmtFQTBoOCIsImlhdCI6MTc3MzA5MjY3NSwiZXhwIjoxNzczMDk2Mjc1LCJqdGkiOiJJRC5IRWE4VlU0TTkyUktSMVoyVjlOWTkxTmVDX3hkRm9HcmNtLWw5Q3hPRmNzIiwiYW1yIjpbIm1mYSIsInB3ZCIsImh3ayIsInVzZXIiXSwiaWRwIjoiMDBvcG9ydXhkZzFJbm9tN2cwaDciLCJwcmVmZXJyZWRfdXNlcm5hbWUiOiJpdmFuLmdvdHRpQG9rdGEuY29tIiwiYXV0aF90aW1lIjoxNzczMDkyNjc1LCJhdF9oYXNoIjoib05SNWhqb1ZwQ3RtcV82bWVDTEJuQSJ9.glMg-kZOeL4ErL7-O9popYfvg-jqbe7_M_BXfveh1vUGxberN1ovo_858oWyu6RrjIotSkuezaldMYUykf17s4Eqi6BVc3MK6mryKdGLf-1IJ9KjRmlpTxogQRYSg_axmDf7ZjRGWAqEpuH39vxl9R3-F8ONyyktMGjjHUdmqGvZca8UgBOUBKu4pu8n9wjPyyqJHyIY5kX65AfXkt8tQLpYJfEUvqe3GPski0fevyHLTc2yuh4sUKRqeXTzJ0ZMMPrNTEOiLZuSvwcIJIuEcIVgZtGmUExbJ6CenAiigPdnx2VAEI14_bDVlCC53flprHzeJF5w-0d_inBq8n5Udw'

echo "Testing at CUSTOM auth server endpoint..."
echo ""

curl -v -X POST 'https://blackcastle.oktapreview.com/oauth2/aus2o8ra5nfzluTlI0h8/v1/token' \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -H 'Accept: application/json' \
  --data-urlencode "grant_type=urn:ietf:params:oauth:grant-type:token-exchange" \
  --data-urlencode "requested_token_type=urn:ietf:params:oauth:token-type:id-jag" \
  --data-urlencode "subject_token=$ID_TOKEN" \
  --data-urlencode "subject_token_type=urn:ietf:params:oauth:token-type:id_token" \
  --data-urlencode "client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer" \
  --data-urlencode "client_assertion=$CLIENT_ASSERTION" \
  --data-urlencode "audience=https://blackcastle.oktapreview.com/oauth2/aus2o8ra5nfzluTlI0h8" \
  --data-urlencode "scope=ask-nist-mcp"
