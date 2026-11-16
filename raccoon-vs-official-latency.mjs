// 官方 DeepSeek 路由 vs 商汤（raccoon）路由：同一分钟内交替对拍首 token 延迟。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CRED = fs.readFileSync(path.join(os.homedir(), '.dsh', '.credentials.yaml'), 'utf8');
const dsTok = CRED.slice(CRED.indexOf('deepseek-account-platform/default'), CRED.indexOf('deepseek-account-platform/default') + 3000).match(/token:\s*(\S+)/)[1];
const raccoonRec = JSON.parse(CRED.match(/RACCOON_ACCOUNT_[0-9A-F]+:\s*'(\{.*?\})'/s)[1]);

const now = () => Number(process.hrtime.bigint() / 1000n) / 1000;

async function chat({ url, headers, model, label }) {
  const body = JSON.stringify({ model, messages: [{ role: 'user', content: '说一句五字以内的话' }], stream: true, max_tokens: 8 });
  const t0 = now();
  const res = await fetch(url, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', Accept: 'text/event-stream' }, body });
  if (!res.ok) { await res.text(); return { label, status: res.status, ttft: null }; }
  const reader = res.body.getReader();
  let first;
  for (;;) { const { done } = await reader.read(); if (done) break; if (first === undefined) first = now() - t0; }
  return { label, status: 200, ttft: first === undefined ? null : Math.round(first), total: Math.round(now() - t0) };
}

const DS = { url: 'https://api.deepseek.com/v1/chat/completions', headers: { 'x-dsh-auth-token': dsTok }, model: 'deepseek-flash', label: 'official/deepseek-flash' };
const RC = {
  url: 'https://xiaohuanxiong.com/api/web/llm/v2/chat/completions',
  headers: {
    Authorization: `Bearer ${raccoonRec.access_token}`, 'X-Org-Code': raccoonRec.office_identity ?? '',
    'X-Raccoon-Language': 'zh', 'X-Client-Platform': 'desktop-windows',
  },
  model: 'sn-deepseek-v4-1-flash-1017', label: 'raccoon/1017(free)',
};

const rows = [];
for (let r = 1; r <= 4; r++) {
  const a = await chat(DS); rows.push(a);
  const b = await chat(RC); rows.push(b);
  console.log(`round#${r}  ${a.label} ttft=${a.ttft}ms  |  ${b.label} ttft=${b.ttft}ms ${b.status !== 200 ? '(status ' + b.status + ')' : ''}`);
}
const med = (label) => { const v = rows.filter(x => x.label === label && x.ttft).map(x => x.ttft).sort((x, y) => x - y); return v.length ? v[Math.floor(v.length / 2)] : null; };
console.log('median official =', med('official/deepseek-flash'), 'ms | median raccoon =', med('raccoon/1017(free)'), 'ms');
