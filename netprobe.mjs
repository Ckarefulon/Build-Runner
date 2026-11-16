// Probe Node TLS reachability (this is the stack DSH/pnpm use).
const targets = [
  'https://registry.npmmirror.com/',
  'https://github.com/wjun19/dsh-trae-connect/info/refs?service=git-upload-pack',
  'https://codeload.github.com/wjun19/dsh-trae-connect/tar.gz/HEAD',
  'https://gh-proxy.com/',
  'https://www.baidu.com/',
];

for (const url of targets) {
  const started = Date.now();
  try {
    const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(20000) });
    const body = res.body ? await res.text() : '';
    console.log(`OK   ${res.status} ${url} (${Date.now() - started}ms, ${body.length} bytes)`);
    if (url.includes('info/refs')) {
      console.log(`     git-advert=${body.includes('# service=git-upload-pack')}`);
      const m = /([0-9a-f]{40}) HEAD/.exec(body);
      console.log(`     HEAD=${m ? m[1] : 'n/a'}`);
    }
  } catch (err) {
    console.log(`FAIL ${url} (${Date.now() - started}ms) ${err?.cause?.code ?? ''} ${err?.message}`);
  }
}
