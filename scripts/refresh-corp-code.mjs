// dart-mcp / scripts/refresh-corp-code.mjs
//
// OpenDART corpCode.xml(zip, 전체 등록법인 목록)을 받아서 회사명 검색에 필요한
// 필드만 추린 JSON으로 저장소에 커밋해두는 스크립트.
//
// 왜 필요한가: Vercel 서버리스 함수(iad1 리전)에서 opendart.fss.or.kr의 corpCode.xml을
// 요청 시점에 직접 다운로드하면 응답 헤더는 1초 이내에 오지만 실제 파일 본문(3.5MB)이
// 60초가 지나도 끝나지 않는 문제가 실제로 발생했다(2026-07-25 Vercel Runtime Logs로
// 확인, 소규모 JSON API 호출은 동일 호스트에서 정상 작동하므로 대용량 파일에 한정된
// 스로틀링으로 추정). 요청 처리 경로에서 이 대용량 다운로드를 완전히 제거하기 위해,
// GitHub Actions가 주기적으로(기본 매일 1회) 이 스크립트를 실행해 결과를 리포지토리에
// 커밋하고, dart-mcp 런타임(lib/dart_client.js)은 이 정적 파일만 읽는다.
// (krx-regulation-mcp의 주간 재크롤링 → 자동 커밋 → Vercel 자동 재배포 패턴과 동일)
//
// 실행: DART_API_KEY=xxx node scripts/refresh-corp-code.mjs

import AdmZip from "adm-zip";
import { writeFileSync, mkdirSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_PATH = path.join(__dirname, "..", "data", "corp_code.json");

const key = process.env.DART_API_KEY;
if (!key) {
  console.error("DART_API_KEY 환경변수가 필요합니다.");
  process.exit(1);
}

const url = `https://opendart.fss.or.kr/api/corpCode.xml?crtfc_key=${key}`;

function extractTag(block, tag) {
  const openTag = `<${tag}>`;
  const closeTag = `</${tag}>`;
  const s = block.indexOf(openTag);
  if (s === -1) return "";
  const e = block.indexOf(closeTag, s);
  if (e === -1) return "";
  return block.slice(s + openTag.length, e).trim();
}

async function main() {
  console.log(`[refresh-corp-code] corpCode.xml 다운로드 시작: ${new Date().toISOString()}`);
  const t0 = Date.now();
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
  });
  if (!res.ok) {
    throw new Error(`DART corpCode.xml HTTP ${res.status}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  console.log(`[refresh-corp-code] 다운로드 완료: ${Date.now() - t0}ms, size=${buf.length} bytes`);

  const zip = new AdmZip(buf);
  const entry = zip.getEntries()[0];
  const xml = entry.getData().toString("utf-8");

  const list = [];
  const LIST_OPEN = "<list>";
  const LIST_CLOSE = "</list>";
  let pos = 0;
  while (true) {
    const start = xml.indexOf(LIST_OPEN, pos);
    if (start === -1) break;
    const end = xml.indexOf(LIST_CLOSE, start);
    if (end === -1) break;
    const block = xml.slice(start + LIST_OPEN.length, end);
    const corp_code = extractTag(block, "corp_code");
    const corp_name = extractTag(block, "corp_name");
    const stock_code = extractTag(block, "stock_code");
    const modify_date = extractTag(block, "modify_date");
    // corp_name이 없는 레코드는 검색에 쓸모없으므로 제외 (실제로는 거의 없음).
    if (corp_code && corp_name) {
      list.push({ corp_code, corp_name, stock_code, modify_date });
    }
    pos = end + LIST_CLOSE.length;
  }

  console.log(`[refresh-corp-code] 파싱 완료: entries=${list.length}`);

  mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  const payload = {
    generatedAt: new Date().toISOString(),
    count: list.length,
    list,
  };
  writeFileSync(OUT_PATH, JSON.stringify(payload), "utf-8");
  console.log(`[refresh-corp-code] 저장 완료: ${OUT_PATH} (${JSON.stringify(payload).length} bytes)`);
}

main().catch((err) => {
  console.error("[refresh-corp-code] 실패:", err);
  process.exit(1);
});
