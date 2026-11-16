// Does owner wjun19 exist? Any repo like trae-connect?
const urls = [
  'https://gh-proxy.com/https://api.github.com/users/wjun19',
  'https://gh-proxy.com/https://api.github.com/users/wjun19/repos?per_page=100&sort=updated',
  'https://gh-proxy.com/https://api.github.com/search/repositories?q=trae-connect',
  'https://gh-proxy.com/https://api.github.com/search/repositories?q=dsh-trae',
];
for (const url of urls) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(25000) });
    const j = await res.json().catch(() => null);
    console.log(`\n=== ${res.status} ${url}`);
    if (Array.isArray(j)) console.log(j.map(r => `${r.full_name} (${r.private ? 'private' : 'public'})`).join('\n') || '(none)');
    else if (j?.items) console.log(j.items.map(r => r.full_name).join('\n') || '(none)');
    else console.log(JSON.stringify(j)?.slice(0, 300));
  } catch (e) { console.log(`\n=== FAIL ${url} ${e?.message}`); }
}
