// Inspect candidate public repos named dsh-trae-connect.
const repos = [
  'yembors64632/dsh-trae-connect',
  'Lewis-0710/dsh-trae-connect',
  'lament-z/dsh-trae-connect',
];
for (const repo of repos) {
  console.log(`\n########## ${repo}`);
  const api = `https://gh-proxy.com/https://api.github.com/repos/${repo}`;
  try {
    const r = await fetch(api, { signal: AbortSignal.timeout(25000) });
    const j = await r.json();
    console.log(`status=${r.status} stars=${j.stargazers_count} pushed=${j.pushed_at} branch=${j.default_branch} desc=${j.description}`);
    if (r.status !== 200) continue;
    for (const f of ['package.json', 'README.md']) {
      const raw = `https://gh-proxy.com/https://raw.githubusercontent.com/${repo}/${j.default_branch}/${f}`;
      const rr = await fetch(raw, { signal: AbortSignal.timeout(25000) });
      const text = await rr.text();
      console.log(`  --- ${f} (${rr.status}) ---`);
      console.log(text.slice(0, f === 'package.json' ? 1200 : 500).replace(/\n{2,}/g, '\n'));
    }
  } catch (e) { console.log(`FAIL ${e?.message}`); }
}
