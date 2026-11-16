// Probe repo existence and routes.
const repo = 'wjun19/dsh-trae-connect';
const targets = [
  `https://codeload.github.com/${repo}/tar.gz/refs/heads/main`,
  `https://codeload.github.com/${repo}/tar.gz/refs/heads/master`,
  `https://gh-proxy.com/https://github.com/${repo}`,
  `https://gh-proxy.com/https://api.github.com/repos/${repo}`,
  `https://gh-proxy.com/https://github.com/${repo}/info/refs?service=git-upload-pack`,
  `https://gh-proxy.com/https://codeload.github.com/${repo}/tar.gz/refs/heads/main`,
  `https://gh-proxy.com/https://raw.githubusercontent.com/${repo}/main/package.json`,
  `https://gh-proxy.com/https://raw.githubusercontent.com/${repo}/master/package.json`,
];

for (const url of targets) {
  try {
    const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(25000) });
    const body = await res.text();
    console.log(`\n=== ${res.status} ${url}`);
    console.log(body.slice(0, 300).replace(/\s+/g, ' '));
    if (url.includes('info/refs')) {
      const m = /([0-9a-f]{40}) HEAD/.exec(body);
      console.log(`   git-advert=${body.includes('# service=git-upload-pack')} HEAD=${m ? m[1] : 'n/a'}`);
    }
  } catch (err) {
    console.log(`\n=== FAIL ${url} :: ${err?.cause?.code ?? ''} ${err?.message}`);
  }
}
