import { klona } from './klona.mjs';

const src = {
  a: 1,
  nested: { b: [1, 2, { c: 3 }] },
  m: new Map([['k', { deep: true }]]),
  s: new Set([{ deep: true }]),
  d: new Date(0),
  r: /abc/gi,
  buf: new Uint8Array([1, 2, 3]),
};

const out = klona(src);

// 深拷贝性：改副本不该动原对象
out.nested.b[2].c = 999;
out.m.get('k').deep = false;
out.d.setUTCFullYear(1999);

console.log('原对象 nested:', src.nested.b[2].c);
console.log('原对象 Map    :', src.m.get('k').deep);
console.log('原对象 Date   :', src.d.getUTCFullYear());
console.log('副本   Date   :', out.d.getUTCFullYear());
console.log('副本 nested is:', out.nested.b[2].c);
console.log('副本 Map     is:', out.m.get('k').deep);
console.log('类型保真     :', Object.prototype.toString.call(out.m), Object.prototype.toString.call(out.r), out.r.flags, out.buf instanceof Uint8Array);
console.log('源未被污染   :', src.buf.join(',') === out.buf.join(',') && src.d.getUTCFullYear() === 1970);
