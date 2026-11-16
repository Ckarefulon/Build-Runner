// Control: verify the probe can see a known-public repo, then retest the target.
const cases = [
  ['CONTROL', 'sindresorhus/p-limit'],
  ['TARGET ', 'wjun19/dsh-trae-connect'],
  ['OWNER  ', 'wjun19/dshmarket'],
];

for (const [label, repo] of cases) {
  const api = `https://gh-proxy.com/https://api.github.com/repos/${repo}`;
  const git = `https://gh-proxy.com/https://github.com/${repo}/info/refs?service=git-upload-pack`;
  try {
    const r = await fetch(api, { signal: AbortSignal.timeout(25000) });
    const j = await r.json().catch(() => null);
    console.log(`${label} api=${r.status} full_name=${j?.full_name ?? j?.message ?? '?'} default_branch=${j?.default_branch ?? '-'} private=${j?.private ?? '-'}`);
  } catch (e) { console.log(`${label} api FAIL ${e?.message}`); }
  try {
    const r = await fetch(git, { signal: AbortSignal.timeout(25000) });
    const t = await r.text();
    const m = /([0-9a-f]{40}) HEAD/.exec(t);
    console.log(`${label} git=${r.status} advert=${t.includes('# service=git-upload-pack')} HEAD=${m ? m[1] : 'n/a'}`);
  } catch (e) { console.log(`${label} git FAIL ${e?.message}`); }
}
