// 1) Catalog lookup for dsh-trae-connect  2) OAuth evidence in candidate repos
const catalogUrls = [
  'https://awesome-dsh-plugin.com/plugins.json',
  'https://registry.npmmirror.com/dsh-plugin-catalog/latest',
];
for (const url of catalogUrls) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
    const text = await res.text();
    console.log(`\n=== ${res.status} ${url} (${text.length} bytes)`);
    let data = null;
    try { data = JSON.parse(text); } catch {}
    if (data?.dist?.tarball) { console.log('  npm wrapper tarball:', data.dist.tarball); continue; }
    const list = Array.isArray(data) ? data : (data?.plugins ?? data?.entries ?? []);
    const hits = list.filter(p => JSON.stringify(p).toLowerCase().includes('trae'));
    console.log(`  entries=${list.length} trae-hits=${hits.length}`);
    for (const h of hits) console.log('  *', JSON.stringify(h).slice(0, 400));
  } catch (e) { console.log(`\n=== FAIL ${url} ${e?.message}`); }
}
