'use strict';
var assert = require('node:assert/strict');
var fs = require('node:fs');
var path = require('node:path');
var root = path.resolve(__dirname, '..');
var login = require('../api/login');

process.env.ADMIN_PASSWORD = 'correct-password';
process.env.SESSION_SECRET = 'test-secret-with-at-least-thirty-two-characters';
process.env.GITHUB_TOKEN = 'github-test-token';
process.env.GITHUB_OWNER = 'owner';
process.env.GITHUB_REPO = 'repo';
process.env.GITHUB_BRANCH = 'main';

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'));
}

function response() {
  return {
    statusCode: 200,
    headers: {},
    setHeader: function (name, value) { this.headers[name.toLowerCase()] = value; },
    end: function (body) { this.body = body; this.json = body ? JSON.parse(body) : {}; }
  };
}

function request(method, body, extraHeaders) {
  return {
    method: method,
    body: body,
    headers: Object.assign({ origin: 'https://portfolio.example', host: 'portfolio.example' }, extraHeaders || {}),
    socket: { remoteAddress: '127.0.0.1' }
  };
}

async function authenticatedCookie() {
  var req = request('POST', { password: process.env.ADMIN_PASSWORD }, { 'x-forwarded-for': 'login-' + Math.random() });
  var res = response();
  await login(req, res);
  assert.equal(res.statusCode, 200);
  return res.headers['set-cookie'].split(';')[0];
}

function githubResponse(data, status) {
  return {
    ok: !status || status < 400,
    status: status || 200,
    json: async function () { return data; }
  };
}

module.exports = { readJson, response, request, authenticatedCookie, githubResponse };
