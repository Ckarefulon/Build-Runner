const fs = require('node:fs');
const path = require('node:path');
const root = process.argv[2];
const terms = ['new Notification(', 'setBadgeCount', 'flashFrame', 'Notification.isSupported', 'showNotification', 'dshDesktop'];
const hits = [];
function walk(dir, depth) {
  if (depth > 5) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries.slice(0, 500)) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' && depth > 1) continue;
      walk(p, depth + 1);
    } else if (/\.(js|mjs|cjs)$/.test(e.name)) {
      let st; try { st = fs.statSync(p); } catch { continue; }
      if (st.size > 3 * 1024 * 1024) continue;
      let src; try { src = fs.readFileSync(p, 'utf8'); } catch { continue; }
      for (const t of terms) if (src.includes(t)) hits.push(p.slice(root.length) + ' :: ' + t);
    }
  }
}
walk(root, 0);
console.log(hits.slice(0, 80).join('\n') || 'NO HITS');
