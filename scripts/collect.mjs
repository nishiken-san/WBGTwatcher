// 気象庁アメダス姫路(63383)の10分値から日別記録を作成し data/records.json に追記する
// GitHub Actions から毎日 00:20 JST に実行される想定（前日分を確定保存＋直近7日の欠損を補完）
import fs from 'node:fs';

const STATION = '63383';
const FILE = 'data/records.json';
const PAST_DAYS = 7;

const records = fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, 'utf8')) : {};

// 簡易WBGT（近似式）
function wbgtEst(t, rh) {
  if (t == null || rh == null) return null;
  const e = rh / 100 * 6.105 * Math.exp(17.27 * t / (237.7 + t));
  return 0.567 * t + 0.393 * e + 3.94;
}

const jstNow = new Date(Date.now() + 9 * 3600 * 1000); // UTC+9（getUTC系で読む）
const dstr = d =>
  `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;

async function fetchDay(ds) {
  const ymd = ds.replaceAll('-', '');
  const blocks = ['00', '03', '06', '09', '12', '15', '18', '21'];
  const results = await Promise.all(blocks.map(async b => {
    try {
      const r = await fetch(`https://www.jma.go.jp/bosai/amedas/data/point/${STATION}/${ymd}_${b}.json`);
      return r.ok ? await r.json() : null;
    } catch { return null; }
  }));

  const samples = [];
  for (const blk of results) {
    if (!blk) continue;
    for (const key in blk) {
      if (!key.startsWith(ymd)) continue;
      const e = blk[key];
      const val = k => (e[k] && e[k][1] === 0 && typeof e[k][0] === 'number') ? e[k][0] : null;
      samples.push({ hm: `${key.slice(8, 10)}:${key.slice(10, 12)}`, t: val('temp'), h: val('humidity') });
    }
  }
  samples.sort((a, b) => a.hm.localeCompare(b.hm));

  const valid = samples.filter(s => s.t != null);
  if (!valid.length) return null;

  const at = hm => samples.find(s => s.hm === hm) || {};
  let mx = valid[0], mn = valid[0], wMax = null;
  for (const s of valid) {
    if (s.t > mx.t) mx = s;
    if (s.t < mn.t) mn = s;
    const w = wbgtEst(s.t, s.h);
    if (w != null && (wMax == null || w > wMax)) wMax = w;
  }
  return {
    t10: at('10:00').t ?? null, h10: at('10:00').h ?? null,
    t15: at('15:00').t ?? null, h15: at('15:00').h ?? null,
    tmax: mx.t, tmaxTime: mx.hm, tmin: mn.t, tminTime: mn.hm,
    wbgtMax: wMax == null ? null : Math.round(wMax * 10) / 10,
    final: true,
  };
}

let updated = 0;
for (let i = 1; i <= PAST_DAYS; i++) {
  const d = new Date(jstNow); d.setUTCDate(d.getUTCDate() - i);
  const ds = dstr(d);
  if (records[ds]?.final) continue;          // 取得済みはスキップ
  const rec = await fetchDay(ds);
  if (rec) { records[ds] = rec; updated++; console.log(`saved ${ds}: max ${rec.tmax}℃ @${rec.tmaxTime}`); }
  else console.log(`no data for ${ds} (公開期間外の可能性)`);
}

// 日付順に整列して保存
const sorted = Object.fromEntries(Object.keys(records).sort().map(k => [k, records[k]]));
fs.writeFileSync(FILE, JSON.stringify(sorted, null, 1));
console.log(`done. updated=${updated}, total=${Object.keys(sorted).length}日分`);
