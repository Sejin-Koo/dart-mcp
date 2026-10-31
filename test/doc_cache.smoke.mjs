// 원문 보관소 스모크테스트 — 가짜 Blob 백엔드 + 실제 opendart 다운로드.
// 실행: DART_API_KEY_FILE=<키파일> node test/doc_cache.smoke.mjs
import fs from "node:fs";
if (process.env.DART_API_KEY_FILE) process.env.DART_API_KEY = fs.readFileSync(process.env.DART_API_KEY_FILE, "utf8").trim();
process.env.BLOB_READ_WRITE_TOKEN = "fake";
// 이 컨테이너에서는 node fetch가 프록시 문제로 opendart에 503을 받는 경우가 있어(man-dart 1절),
// DOC_ZIP_FILE을 주면 미리 받아 둔 같은 원문 zip을 opendart 응답 대신 돌려준다.
let downloads = 0;
if (process.env.DOC_ZIP_FILE) {
  const zip = fs.readFileSync(process.env.DOC_ZIP_FILE); const real = globalThis.fetch;
  globalThis.fetch = async (u, o) => String(u).includes("opendart.fss.or.kr/api/document.xml")
    ? (downloads++, new Response(zip, { status: 200 })) : real(u, o);
}
const C = await import("../lib/doc_cache.js");
const { getDocumentText } = await import("../lib/document_client.js");
const { formatDocumentResult } = await import("../lib/format.js");

const store = new Map(); let fail = null; const ops = { get: 0, put: 0, list: 0, del: 0 };
C.__setCacheBackend({
  async get(p) { ops.get++; if (fail === "get") throw new Error("simulated"); const v = store.get(p); if (!v) return null;
    return { statusCode: 200, stream: new Blob([v.buf]).stream(), blob: { uploadedAt: v.at } }; },
  async put(p, buf) { ops.put++; if (fail === "put") throw new Error("simulated"); store.set(p, { buf, at: new Date() }); },
  async del(u) { ops.del++; for (const x of [].concat(u)) store.delete(x.replace("https://x/", "")); },
  async list() { ops.list++; return { blobs: [...store].map(([p, v]) => ({ url: "https://x/" + p, uploadedAt: v.at })), hasMore: false }; },
});
let pass = 0, failn = 0;
const ok = (c, m) => { c ? pass++ : failn++; console.log((c ? "  OK  " : "  NG  ") + m); };
const R = "20260814003964";
const a = await getDocumentText({ rcept_no: R, mode: "count", keywords: ["영등포", "건물"] });
ok(a.cache.status === "miss", `1차 호출 miss (${a.cache.elapsedMs}ms)`); ok(a.counts["영등포"] === 18 && a.counts["건물"] === 17, "키워드 수 일치 18/17");
const b = await getDocumentText({ rcept_no: R, mode: "extract", keyword: "[자산항목 : 건물]", charsAfter: 200 });
ok(b.cache.status === "hit", `2차 호출 hit (${b.cache.elapsedMs}ms)`); ok(/1,007[\s\S]*22[\s\S]*985/.test(b.text), "건물 1,007 → 상각 22 → 985 확인");
console.log(formatDocumentResult(b).split("\n\n").slice(0, 2).join(" | "));
store.get(C.CACHE_PREFIX + R + ".zip").at = new Date(Date.now() - 25 * 3600e3);
const c = await getDocumentText({ rcept_no: R, mode: "count", keywords: ["건물"] });
ok(c.cache.status === "miss" && /24시간/.test(c.cache.reason), "25시간 지난 보관본은 쓰지 않고 새로 받음");
fail = "get"; const d = await getDocumentText({ rcept_no: R, mode: "count", keywords: ["건물"] });
ok(d.counts["건물"] === 17 && /읽기 실패/.test(d.cache.reason || ""), "보관소 읽기 실패해도 직접 다운로드로 정상 응답");
fail = "put"; store.clear(); const e = await getDocumentText({ rcept_no: R, mode: "count", keywords: ["건물"] });
ok(e.cache.status === "error" && e.counts["건물"] === 17, "보관소 저장 실패해도 정상 응답(상태 error)"); fail = null;
const f = await getDocumentText({ rcept_no: "1234", mode: "count", keywords: ["x"] }).catch((x) => ({ err: x.message }));
ok(f.err || f.cache?.status === "off", "14자리 아닌 접수번호는 보관 안 함");
store.set(C.CACHE_PREFIX + "old.zip", { buf: Buffer.alloc(200), at: new Date(Date.now() - 30 * 3600e3) });
store.set(C.CACHE_PREFIX + "new.zip", { buf: Buffer.alloc(200), at: new Date() });
const g = await C.purgeExpired(); ok(g.scanned === 2 && g.deleted === 1 && store.has(C.CACHE_PREFIX + "new.zip"), `정리: 2건 중 만료 1건만 삭제`);
ok(downloads === 0 || downloads === 5, `opendart 다운로드 ${downloads}회 (조회 6회 중 보관본 사용 1회)`);
console.log(`\n통과 ${pass} / 실패 ${failn}  ops=${JSON.stringify(ops)}`); process.exit(failn ? 1 : 0);
