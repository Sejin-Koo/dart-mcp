// dart-mcp / lib/dart_client.js
// OpenDART(전자공시시스템) REST API 래퍼. 인증키는 환경변수 DART_API_KEY에서만 읽는다.
// 엔드포인트명은 2026-07-25 opendart.fss.or.kr/guide 공식 문서를 실시간 curl로 전수 확인한 값.

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CORP_CODE_PATH = path.join(__dirname, "..", "data", "corp_code.json");

const BASE = "https://opendart.fss.or.kr/api";

function getApiKey() {
  const key = process.env.DART_API_KEY;
  if (!key) {
    throw new Error(
      "DART_API_KEY 환경변수가 설정되어 있지 않습니다. Vercel 프로젝트 설정에서 등록하세요."
    );
  }
  return key;
}

async function callDart(op, params = {}) {
  const crtfc_key = getApiKey();
  const usp = new URLSearchParams({ crtfc_key });
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") usp.set(k, String(v));
  }
  const url = `${BASE}/${op}.json?${usp.toString()}`;
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
  });
  if (!res.ok) {
    throw new Error(`DART API HTTP ${res.status}: ${op}`);
  }
  const data = await res.json();
  // DART 공통 응답: { status, message, list?, page_no?, ... }
  if (data.status === "013") {
    // 013 = 조회된 데이터가 없습니다 → 정상, 빈 결과로 정규화
    return { status: "013", message: data.message, totalCount: 0, items: [] };
  }
  if (data.status !== "000") {
    return { error: true, status: data.status, message: data.message };
  }
  const { status, message, ...rest } = data;
  return { status, message, ...rest };
}

// ---------------------------------------------------------------------------
// DS001 공시정보
// ---------------------------------------------------------------------------

export async function searchDisclosure({
  corp_code,
  bgn_de,
  end_de,
  last_reprt_at,
  pblntf_ty,
  pblntf_detail_ty,
  corp_cls,
  sort,
  sort_mth,
  page_no = 1,
  page_count = 10,
} = {}) {
  return callDart("list", {
    corp_code,
    bgn_de,
    end_de,
    last_reprt_at,
    pblntf_ty,
    pblntf_detail_ty,
    corp_cls,
    sort,
    sort_mth,
    page_no,
    page_count,
  });
}

export async function getCompanyInfo({ corp_code }) {
  if (!corp_code) throw new Error("corp_code는 필수입니다.");
  return callDart("company", { corp_code });
}

// ---------------------------------------------------------------------------
// 고유번호(corp_code) 검색 — data/corp_code.json(정적 파일)에서 회사명으로 필터링.
//
// 예전에는 요청 시점에 opendart.fss.or.kr에서 corpCode.xml(zip, 3.5MB)을 직접
// 받아왔는데, Vercel(iad1 리전) 서버리스 함수에서 이 대용량 파일 다운로드가 응답
// 헤더는 1초 내로 오면서도 본문이 60초가 지나도 끝나지 않는 문제가 실제로 발생했다
// (2026-07-25 Vercel Runtime Logs 확인, 동일 호스트의 소용량 JSON API 호출은 정상
// 작동해서 대용량 파일에 한정된 스로틀링으로 추정). corp_code는 신규 법인 등록·
// 상장·상호변경 때만 바뀌는 정적 성격의 데이터이므로, GitHub Actions가 주기적으로
// (기본 매일 1회, .github/workflows/refresh-corp-code.yml) scripts/refresh-corp-code.mjs를
// 실행해 data/corp_code.json을 리포지토리에 커밋해두고, 여기서는 그 정적 파일만
// 읽는 방식으로 바꿨다. 요청 처리 경로에서 외부 대용량 다운로드가 완전히 빠지므로
// 타임아웃 자체가 발생할 수 없다.
// ---------------------------------------------------------------------------

let corpCodeCache = null; // { list: [...], generatedAt: string }

function loadCorpCodePayload() {
  if (corpCodeCache) return corpCodeCache;
  let raw;
  try {
    raw = readFileSync(CORP_CODE_PATH, "utf-8");
  } catch (err) {
    throw new Error(
      `data/corp_code.json을 찾을 수 없습니다. scripts/refresh-corp-code.mjs를 먼저 실행해 ` +
        `이 파일을 생성/커밋해야 합니다. (원본 오류: ${err.message})`
    );
  }
  const payload = JSON.parse(raw);
  corpCodeCache = { list: payload.list, generatedAt: payload.generatedAt };
  return corpCodeCache;
}

function loadCorpCodeList() {
  return loadCorpCodePayload().list;
}

// 정적 캐시가 오래됐으면(자동 갱신 워크플로 중단 등) 검색 결과에 경고를 붙여
// 사용자가 데이터 정체를 즉시 알아차릴 수 있게 한다.
function staleWarning() {
  const { generatedAt } = loadCorpCodePayload();
  if (!generatedAt) return null;
  const ageDays = (Date.now() - Date.parse(generatedAt)) / 86400000;
  if (ageDays > 3) {
    return (
      `corp_code 데이터가 ${Math.floor(ageDays)}일 전(${generatedAt.slice(0, 10)}) 기준입니다. ` +
      `GitHub Actions의 "Refresh corp_code.json" 워크플로가 실행되고 있는지(DART_API_KEY 시크릿 등록 여부 포함) 확인하세요.`
    );
  }
  return null;
}

// 초성 목록 (19개 현대 한글 초성)
const CHOSUNG_LIST = [
  "ㄱ", "ㄲ", "ㄴ", "ㄷ", "ㄸ", "ㄹ", "ㅁ", "ㅂ", "ㅃ", "ㅅ",
  "ㅆ", "ㅇ", "ㅈ", "ㅉ", "ㅊ", "ㅋ", "ㅌ", "ㅍ", "ㅎ",
];

function isChosungChar(ch) {
  return CHOSUNG_LIST.includes(ch);
}

function isAllChosung(str) {
  return str.length > 0 && [...str].every(isChosungChar);
}

// 완성형 한글 음절 → 초성만 추출 (한글 음절이 아닌 문자는 그대로 통과)
function getChosungString(str) {
  return [...str]
    .map((ch) => {
      const code = ch.charCodeAt(0);
      if (code >= 0xac00 && code <= 0xd7a3) {
        const idx = Math.floor((code - 0xac00) / 588);
        return CHOSUNG_LIST[idx];
      }
      return ch;
    })
    .join("");
}

// query의 모든 문자가 target 안에 순서대로(연속일 필요 없음) 등장하는지 확인.
// "삼전"이 "삼성전자"에 매치되는 것과 같은 약어 검색을 지원하기 위함.
function subsequenceMatch(query, target) {
  let qi = 0;
  let startIdx = -1;
  let lastIdx = -1;
  for (let i = 0; i < target.length && qi < query.length; i++) {
    if (target[i] === query[qi]) {
      if (startIdx === -1) startIdx = i;
      lastIdx = i;
      qi++;
    }
  }
  if (qi === query.length) return { start: startIdx, span: lastIdx - startIdx + 1 };
  return null;
}

// ---------------------------------------------------------------------------
// 자주 쓰는 약칭 → 정식 회사명 별칭 사전.
// corpCode.xml에는 시가총액·거래대금 같은 "인지도" 정보가 없어서, "삼전"류 약칭에서
// 삼성전기·삼화전기 같은 동률 후보를 알고리즘만으로 이길 수 없다(2026-07-25 확인).
// 실무에서 빈번한 약칭만 선별해 결정적으로 처리한다. 별칭이 걸리면 해당 회사를
// 최상단에 두되, 일반 매칭 결과도 뒤이어 함께 반환한다.
// ---------------------------------------------------------------------------
const NAME_ALIASES = {
  삼전: "삼성전자",
  하닉: "SK하이닉스",
  현차: "현대자동차",
  현대차: "현대자동차",
  기아차: "기아",
  엔솔: "LG에너지솔루션",
  LG엔솔: "LG에너지솔루션",
  엘지엔솔: "LG에너지솔루션",
  삼바: "삼성바이오로직스",
  삼성바이오: "삼성바이오로직스",
  카뱅: "카카오뱅크",
  카겜: "카카오게임즈",
  셀트: "셀트리온",
  포홀: "POSCO홀딩스",
  포스코홀딩스: "POSCO홀딩스",
  네이버: "NAVER",
  삼물: "삼성물산",
  현대중공업: "HD현대중공업",
  한화에어로: "한화에어로스페이스",
  두산에너빌: "두산에너빌리티",
  KT앤지: "KT&G",
  케이티앤지: "KT&G",
};

// 한글 음절 → 자모(초성/중성/종성) 문자열 분해. 오타 보정 비교용.
const JUNGSUNG_COUNT = 21;
const JONGSUNG_COUNT = 28;
function decomposeJamo(str) {
  const out = [];
  for (const ch of str) {
    const code = ch.charCodeAt(0);
    if (code >= 0xac00 && code <= 0xd7a3) {
      const idx = code - 0xac00;
      const cho = Math.floor(idx / (JUNGSUNG_COUNT * JONGSUNG_COUNT));
      const jung = Math.floor(idx / JONGSUNG_COUNT) % JUNGSUNG_COUNT;
      const jong = idx % JONGSUNG_COUNT;
      out.push(String.fromCharCode(0x1100 + cho), String.fromCharCode(0x1161 + jung));
      if (jong > 0) out.push(String.fromCharCode(0x11a7 + jong));
    } else {
      out.push(ch);
    }
  }
  return out;
}

// 두 자모 배열의 편집거리(Levenshtein). 오타 1~2자 보정용이라 상한 초과 시 조기 중단.
function jamoEditDistance(a, b, maxDist) {
  if (Math.abs(a.length - b.length) > maxDist) return maxDist + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > maxDist) return maxDist + 1;
    prev = cur;
  }
  return prev[b.length];
}

// needle(음절 n개)과 같은 길이의 연속 음절 창(window)을 name 위에서 밀며 자모
// 편집거리 최솟값을 구한다. "삼성전지"→"삼성전자"(거리1) 같은 오타를 잡기 위함.
function typoWindowDistance(needle, name, maxDist) {
  const nSyll = [...needle];
  const tSyll = [...name];
  if (tSyll.length < nSyll.length) return maxDist + 1;
  const nJamo = decomposeJamo(needle);
  let best = maxDist + 1;
  for (let s = 0; s + nSyll.length <= tSyll.length; s++) {
    const win = tSyll.slice(s, s + nSyll.length).join("");
    const d = jamoEditDistance(nJamo, decomposeJamo(win), maxDist);
    if (d < best) best = d;
    if (best === 0) break;
  }
  return best;
}

export async function searchCorpCode({ corp_name, stock_code, limit = 20 }) {
  if (!corp_name && !stock_code) {
    throw new Error("corp_name 또는 stock_code 중 하나는 필수입니다.");
  }
  const list = await loadCorpCodeList();
  const warning = staleWarning();

  if (stock_code) {
    const results = list.filter((c) => c.stock_code === stock_code);
    return { totalCount: results.length, items: results.slice(0, limit), ...(warning && { warning }) };
  }

  // 매칭 단계(tier): ⓪ 별칭 사전 ① 완전 부분일치 ② 초성 부분일치 ③ 약어(부분수열,
  // 초성 질의는 초성 문자열 위에서도 수행) ④ 오타 보정(자모 편집거리, 다른 매칭이
  // 빈약할 때만). 상장사(종목코드 보유)는 실제 업무상 검색 의도일 가능성이 높으므로
  // tier가 낮은 비상장보다 우선 노출되도록 강한 가중치(UNLISTED_PENALTY)를 준다.
  // 동률(tie)은 매치 시작위치(앞일수록 우선) → 회사명 길이(짧을수록 우선)로 가른다.
  const needle = corp_name.trim();
  const needleIsChosung = isAllChosung(needle);
  const UNLISTED_PENALTY = 25;
  const aliasTarget = NAME_ALIASES[needle] || null;
  const scored = [];
  for (const c of list) {
    const name = c.corp_name;
    const listed = !!c.stock_code;
    let tier = null;
    let tie = 0;
    if (aliasTarget && name === aliasTarget) {
      tier = -1; // 별칭 정확일치는 무조건 최상단
      tie = 0;
    } else if (name.includes(needle)) {
      tier = 0;
      tie = name.indexOf(needle) / 100 + name.length / 1000;
    } else if (needleIsChosung && getChosungString(name).includes(needle)) {
      tier = 1;
      tie = getChosungString(name).indexOf(needle) / 100 + name.length / 1000;
    } else {
      const target = needleIsChosung ? getChosungString(name) : name;
      const sub = subsequenceMatch(needle, target);
      if (sub) {
        tier = 2;
        tie = sub.span / 100 + sub.start / 1000 + name.length / 10000;
      }
    }
    if (tier === null) continue;
    const score = tier * 10 + (listed ? 0 : UNLISTED_PENALTY) + tie;
    scored.push({ c, score });
  }

  // 오타 보정 패스: 상위 결과에 "정확 부분일치 상장사"가 없을 때만 수행(불필요한
  // 비용·잡음 방지). 우선 상장사 약 4천 건만 검사하고, 그래도 0건이면 전체를 검사.
  const hasExactListed = scored.some((s) => s.score < 10);
  const needleSyllables = [...needle].length;
  if (!hasExactListed && !needleIsChosung && needleSyllables >= 3) {
    const maxDist = needleSyllables >= 5 ? 2 : 1;
    const already = new Set(scored.map((s) => s.c.corp_code));
    const passes = [list.filter((c) => c.stock_code), list.filter((c) => !c.stock_code)];
    for (const [pi, pass] of passes.entries()) {
      let found = 0;
      for (const c of pass) {
        if (already.has(c.corp_code)) continue;
        const d = typoWindowDistance(needle, c.corp_name, maxDist);
        if (d <= maxDist) {
          const listed = !!c.stock_code;
          const score = 30 + d * 5 + (listed ? 0 : UNLISTED_PENALTY) + c.corp_name.length / 1000;
          scored.push({ c, score });
          found++;
        }
      }
      // 상장사 패스에서 하나라도 찾았으면 비상장 전수 검사(11만 건)는 생략
      if (pi === 0 && (found > 0 || scored.length > 0)) break;
    }
  }

  scored.sort((a, b) => a.score - b.score);
  const results = scored.map((s) => s.c);
  return { totalCount: results.length, items: results.slice(0, limit), ...(warning && { warning }) };
}

// ---------------------------------------------------------------------------
// DS002 정기보고서 주요정보 (corp_code + bsns_year + reprt_code 공통 패턴)
// reprt_code: 11013=1분기, 11012=반기, 11014=3분기, 11011=사업보고서
// ---------------------------------------------------------------------------

export const PERIODIC_REPORT_ITEMS = {
  stock_total_qty: { op: "stockTotqySttus", label: "주식의 총수 현황" },
  treasury_stock_periodic: { op: "tesstkAcqsDspsSttus", label: "자기주식 취득 및 처분 현황" },
  dividend: { op: "alotMatter", label: "배당에 관한 사항" },
  capital_incdec: { op: "irdsSttus", label: "증자(감자) 현황" },
  debt_securities_issue: { op: "detScritsIsuAcmslt", label: "채무증권 발행실적" },
  cp_outstanding: { op: "entrprsBilScritsNrdmpBlce", label: "기업어음증권 미상환 잔액" },
  st_bond_outstanding: { op: "srtpdPsndbtNrdmpBlce", label: "단기사채 미상환 잔액" },
  corp_bond_outstanding: { op: "cprndNrdmpBlce", label: "회사채 미상환 잔액" },
  hybrid_bond_outstanding: { op: "newCaplScritsNrdmpBlce", label: "신종자본증권 미상환 잔액" },
  contingent_capital_outstanding: {
    op: "cndlCaplScritsNrdmpBlce",
    label: "조건부 자본증권 미상환 잔액",
  },
  public_offering_fund_use: { op: "pssrpCptalUseDtls", label: "공모자금의 사용내역" },
  private_offering_fund_use: { op: "prvsrpCptalUseDtls", label: "사모자금의 사용내역" },
  auditor_opinion: { op: "accnutAdtorNmNdAdtOpinion", label: "회계감사인의 명칭 및 감사의견" },
  audit_service_contract: { op: "adtServcCnclsSttus", label: "감사용역체결현황" },
  non_audit_service: {
    op: "accnutAdtorNonAdtServcCnclsSttus",
    label: "회계감사인과의 비감사용역 계약체결 현황",
  },
  outside_director: { op: "outcmpnyDrctrNdChangeSttus", label: "사외이사 및 그 변동현황" },
  largest_shareholder: { op: "hyslrSttus", label: "최대주주 현황" },
  largest_shareholder_change: { op: "hyslrChgSttus", label: "최대주주 변동현황" },
  minority_shareholder: { op: "mrhlSttus", label: "소액주주 현황" },
  executive_status: { op: "exctvSttus", label: "임원 현황" },
  employee_status: { op: "empSttus", label: "직원 현황" },
  unregistered_exec_comp: { op: "unrstExctvMendngSttus", label: "미등기임원 보수현황" },
  director_auditor_comp_approved: {
    op: "drctrAdtAllMendngSttusGmtsckConfmAmount",
    label: "이사·감사 전체의 보수현황(주주총회 승인금액)",
  },
  director_auditor_comp_total: {
    op: "hmvAuditAllSttus",
    label: "이사·감사 전체의 보수현황(보수지급금액-전체)",
  },
  director_auditor_comp_bytype: {
    op: "drctrAdtAllMendngSttusMendngPymntamtTyCl",
    label: "이사·감사 전체의 보수현황(보수지급금액-유형별)",
  },
  individual_comp_over500m_v1: {
    op: "hmvAuditIndvdlBySttus",
    label: "이사·감사 개인별 보수현황(5억이상, ~2026.4 제출분)",
  },
  individual_comp_over500m_v2: {
    op: "hmvAuditIndvdlBySttusV2",
    label: "이사·감사 개인별 보수현황(5억이상, 2026.5~ 제출분)",
  },
  top5_comp_v1: {
    op: "indvdlByPay",
    label: "개인별 보수지급금액(5억이상 상위5인, ~2026.4 제출분)",
  },
  top5_comp_v2: {
    op: "indvdlByPayV2",
    label: "개인별 보수지급금액(5억이상 상위5인, 2026.5~ 제출분)",
  },
  investment_in_others: { op: "otrCprInvstmntSttus", label: "타법인 출자현황" },
};

export async function getPeriodicReportItem({ reportItem, corp_code, bsns_year, reprt_code }) {
  const item = PERIODIC_REPORT_ITEMS[reportItem];
  if (!item) throw new Error(`알 수 없는 reportItem: ${reportItem}`);
  if (!corp_code || !bsns_year || !reprt_code) {
    throw new Error("corp_code, bsns_year, reprt_code는 모두 필수입니다.");
  }
  const result = await callDart(item.op, { corp_code, bsns_year, reprt_code });
  return { reportItem, label: item.label, ...result };
}

// ---------------------------------------------------------------------------
// DS003 정기보고서 재무정보
// ---------------------------------------------------------------------------

export const FINANCIAL_STATEMENT_ITEMS = {
  single_account: {
    op: "fnlttSinglAcnt",
    label: "단일회사 주요계정",
    extra: [],
  },
  multi_account: {
    op: "fnlttMultiAcnt",
    label: "다중회사 주요계정 (corp_code를 콤마로 최대 100개까지)",
    extra: [],
  },
  single_index: {
    op: "fnlttSinglIndx",
    label: "단일회사 주요 재무지표",
    extra: ["idx_cl_code"],
  },
  multi_index: {
    op: "fnlttCmpnyIndx",
    label: "다중회사 주요 재무지표 (corp_code를 콤마로 최대 100개까지)",
    extra: ["idx_cl_code"],
  },
  single_all: {
    op: "fnlttSinglAcntAll",
    label: "단일회사 전체 재무제표",
    extra: ["fs_div"],
  },
  xbrl_taxonomy: {
    op: "xbrlTaxonomy",
    label: "XBRL 표준계정과목체계(택사노미)",
    extra: ["sj_div_only"],
  },
};

export async function getFinancialStatement({
  infoType,
  corp_code,
  bsns_year,
  reprt_code,
  idx_cl_code,
  fs_div,
  sj_div,
}) {
  const item = FINANCIAL_STATEMENT_ITEMS[infoType];
  if (!item) throw new Error(`알 수 없는 infoType: ${infoType}`);
  // xbrl_taxonomy는 corp_code 없이 sj_div만 필요 (표준계정과목체계 자체 조회)
  if (item.extra.includes("sj_div_only")) {
    if (!sj_div) {
      throw new Error(
        "xbrl_taxonomy는 sj_div가 필수입니다 (BS1~BS4, IS1~IS4, CIS1~CIS4, DCIS1~DCIS5, CF1~CF4, SCE1~SCE2)."
      );
    }
    const result = await callDart(item.op, { sj_div });
    return { infoType, label: item.label, ...result };
  }
  if (!corp_code || !bsns_year || !reprt_code) {
    throw new Error("corp_code, bsns_year, reprt_code는 모두 필수입니다.");
  }
  const params = { corp_code, bsns_year, reprt_code };
  if (item.extra.includes("idx_cl_code")) {
    if (!idx_cl_code) throw new Error("이 infoType은 idx_cl_code가 필수입니다 (M:수익성/안정성/성장성/활동성 지표).");
    params.idx_cl_code = idx_cl_code;
  }
  if (item.extra.includes("fs_div")) {
    if (!fs_div) throw new Error("이 infoType은 fs_div가 필수입니다 (OFS:재무제표, CFS:연결재무제표).");
    params.fs_div = fs_div;
  }
  const result = await callDart(item.op, params);
  return { infoType, label: item.label, ...result };
}

// ---------------------------------------------------------------------------
// DS004 지분공시 종합정보 (corp_code만 필요)
// ---------------------------------------------------------------------------

export const EQUITY_DISCLOSURE_ITEMS = {
  major_holding: { op: "majorstock", label: "대량보유 상황보고" },
  exec_holding: { op: "elestock", label: "임원ㆍ주요주주 소유보고" },
};

export async function getEquityDisclosure({ infoType, corp_code }) {
  const item = EQUITY_DISCLOSURE_ITEMS[infoType];
  if (!item) throw new Error(`알 수 없는 infoType: ${infoType}`);
  if (!corp_code) throw new Error("corp_code는 필수입니다.");
  const result = await callDart(item.op, { corp_code });
  return { infoType, label: item.label, ...result };
}

// ---------------------------------------------------------------------------
// DS005 주요사항보고서 주요정보 (corp_code + bgn_de + end_de 공통 패턴)
// ---------------------------------------------------------------------------

export const MAJOR_REPORT_ITEMS = {
  default_occurrence: { op: "dfOcr", label: "부도발생" },
  bond_transfer_decision: { op: "stkrtbdTrfDecsn", label: "주권 관련 사채권 양도 결정" },
  rehabilitation_start: { op: "ctrcvsBgrq", label: "회생절차 개시신청" },
  dissolution: { op: "dsRsOcr", label: "해산사유 발생" },
  rights_offering: { op: "piicDecsn", label: "유상증자 결정" },
  bonus_issue: { op: "fricDecsn", label: "무상증자 결정" },
  rights_bonus_issue: { op: "pifricDecsn", label: "유무상증자 결정" },
  capital_reduction: { op: "crDecsn", label: "감자 결정" },
  creditor_mgmt_start: { op: "bnkMngtPcbg", label: "채권은행 등의 관리절차 개시" },
  lawsuit: { op: "lwstLg", label: "소송 등의 제기" },
  overseas_listing_decision: { op: "ovLstDecsn", label: "해외 증권시장 주권등 상장 결정" },
  overseas_delisting_decision: { op: "ovDlstDecsn", label: "해외 증권시장 주권등 상장폐지 결정" },
  overseas_listing: { op: "ovLst", label: "해외 증권시장 주권등 상장" },
  overseas_delisting: { op: "ovDlst", label: "해외 증권시장 주권등 상장폐지" },
  convertible_bond: { op: "cvbdIsDecsn", label: "전환사채권 발행결정" },
  bond_with_warrant: { op: "bdwtIsDecsn", label: "신주인수권부사채권 발행결정" },
  exchangeable_bond: { op: "exbdIsDecsn", label: "교환사채권 발행결정" },
  creditor_mgmt_stop: { op: "bnkMngtPcsp", label: "채권은행 등의 관리절차 중단" },
  contingent_capital_bond: { op: "wdCocobdIsDecsn", label: "상각형 조건부자본증권 발행결정" },
  asset_transfer_putback: { op: "astInhtrfEtcPtbkOpt", label: "자산양수도(기타), 풋백옵션" },
  other_stock_transfer: { op: "otcprStkInvscrTrfDecsn", label: "타법인 주식 및 출자증권 양도결정" },
  tangible_asset_transfer: { op: "tgastTrfDecsn", label: "유형자산 양도 결정" },
  tangible_asset_acquisition: { op: "tgastInhDecsn", label: "유형자산 양수 결정" },
  other_stock_acquisition: { op: "otcprStkInvscrInhDecsn", label: "타법인 주식 및 출자증권 양수결정" },
  business_transfer: { op: "bsnTrfDecsn", label: "영업양도 결정" },
  business_acquisition: { op: "bsnInhDecsn", label: "영업양수 결정" },
  treasury_trust_termination: { op: "tsstkAqTrctrCcDecsn", label: "자기주식취득 신탁계약 해지 결정" },
  treasury_trust_contract: { op: "tsstkAqTrctrCnsDecsn", label: "자기주식취득 신탁계약 체결 결정" },
  treasury_disposal: { op: "tsstkDpDecsn", label: "자기주식 처분 결정" },
  treasury_acquisition: { op: "tsstkAqDecsn", label: "자기주식 취득 결정" },
  stock_exchange_transfer: { op: "stkExtrDecsn", label: "주식교환·이전 결정" },
  division_merger: { op: "cmpDvmgDecsn", label: "회사분할합병 결정" },
  division: { op: "cmpDvDecsn", label: "회사분할 결정" },
  merger: { op: "cmpMgDecsn", label: "회사합병 결정" },
  bond_acquisition: { op: "stkrtbdInhDecsn", label: "주권 관련 사채권 양수 결정" },
  business_suspension: { op: "bsnSp", label: "영업정지" },
};

export async function getMajorReportItem({ reportItem, corp_code, bgn_de, end_de }) {
  const item = MAJOR_REPORT_ITEMS[reportItem];
  if (!item) throw new Error(`알 수 없는 reportItem: ${reportItem}`);
  if (!corp_code || !bgn_de || !end_de) {
    throw new Error("corp_code, bgn_de, end_de는 모두 필수입니다.");
  }
  const result = await callDart(item.op, { corp_code, bgn_de, end_de });
  return { reportItem, label: item.label, ...result };
}

// ---------------------------------------------------------------------------
// DS006 증권신고서 주요정보 (corp_code + bgn_de + end_de 공통 패턴)
// ---------------------------------------------------------------------------

export const SECURITIES_REPORT_ITEMS = {
  reg_stock_exchange_transfer: { op: "extrRs", label: "주식의포괄적교환·이전" },
  reg_merger: { op: "mgRs", label: "합병" },
  reg_division: { op: "dvRs", label: "분할" },
  reg_debt_securities: { op: "bdRs", label: "채무증권" },
  reg_equity_securities: { op: "estkRs", label: "지분증권" },
  reg_depositary_receipts: { op: "stkdpRs", label: "증권예탁증권" },
};

export async function getSecuritiesReportItem({ reportItem, corp_code, bgn_de, end_de }) {
  const item = SECURITIES_REPORT_ITEMS[reportItem];
  if (!item) throw new Error(`알 수 없는 reportItem: ${reportItem}`);
  if (!corp_code || !bgn_de || !end_de) {
    throw new Error("corp_code, bgn_de, end_de는 모두 필수입니다.");
  }
  const result = await callDart(item.op, { corp_code, bgn_de, end_de });
  return { reportItem, label: item.label, ...result };
}
