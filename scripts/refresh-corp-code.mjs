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
import { writeFileSync, mkdirSync, readFileSync } from "fs";
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

// 데이터센터 IP 대역에서 opendart의 대용량 파일 전송이 간헐적으로 503을 반환하거나
// 극단적으로 느려지는 사례가 실측됨(2026-08-04 클라우드 환경에서 재현: 소용량 JSON은
// 정상, corpCode.xml만 503 또는 15KB/s 수준). 타임아웃 + 재시도(백오프)로 방어한다.
const MAX_ATTEMPTS = 4;
const TIMEOUT_MS = 240_000; // 다운로드 1회당 최대 4분
const BACKOFF_MS = [0, 30_000, 60_000, 120_000];

async function downloadWithRetry() {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (BACKOFF_MS[attempt - 1]) {
      console.log(`[refresh-corp-code] ${BACKOFF_MS[attempt - 1] / 1000}초 대기 후 재시도...`);
      await new Promise((r) => setTimeout(r, BACKOFF_MS[attempt - 1]));
    }
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
    try {
      console.log(`[refresh-corp-code] 다운로드 시도 ${attempt}/${MAX_ATTEMPTS}`);
      const t0 = Date.now();
      const res = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
        signal: ac.signal,
      });
      if (!res.ok) throw new Error(`DART corpCode.xml HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      // zip 시그니처(PK) + 최소 크기 검증 — 오류 페이지를 zip으로 착각하지 않도록
      if (buf.length < 500_000 || buf[0] !== 0x50 || buf[1] !== 0x4b) {
        throw new Error(`다운로드 결과가 정상 zip이 아님 (size=${buf.length})`);
      }
      console.log(`[refresh-corp-code] 다운로드 완료: ${Date.now() - t0}ms, size=${buf.length} bytes`);
      return buf;
    } catch (err) {
      lastErr = err;
      console.warn(`[refresh-corp-code] 시도 ${attempt} 실패: ${err.message}`);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

async function main() {
  console.log(`[refresh-corp-code] corpCode.xml 다운로드 시작: ${new Date().toISOString()}`);
  const buf = await downloadWithRetry();

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

  // 기존 파일보다 건수가 10% 이상 줄었으면 부분 응답/데이터 이상으로 보고 덮어쓰지 않음
  try {
    const prev = JSON.parse(readFileSync(OUT_PATH, "utf-8"));
    if (prev.count && list.length < prev.count * 0.9) {
      throw new Error(
        `신규 건수(${list.length})가 기존(${prev.count})보다 10% 이상 감소 — 부분 응답 의심, 갱신 중단`
      );
    }
  } catch (err) {
    if (err.message.includes("갱신 중단")) throw err;
    // 기존 파일이 없거나 읽기 실패면 그대로 진행
  }

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
