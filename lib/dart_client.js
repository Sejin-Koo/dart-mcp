// dart-mcp / lib/dart_client.js
// OpenDART(전자공시시스템) REST API 래퍼. 인증키는 환경변수 DART_API_KEY에서만 읽는다.
// 엔드포인트명은 2026-07-25 opendart.fss.or.kr/guide 공식 문서를 실시간 curl로 전수 확인한 값.

import AdmZip from "adm-zip";

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
// 고유번호(corp_code) 검색 — corpCode.xml(zip) 벌크 다운로드 후 회사명으로 필터링.
// Vercel 서버리스 warm instance 동안 모듈 스코프 캐시(24시간 TTL)로 재다운로드 최소화.
// ---------------------------------------------------------------------------

let corpCodeCache = null; // { list: [{corp_code, corp_name, stock_code, modify_date}], fetchedAt }
const CORP_CODE_TTL_MS = 24 * 60 * 60 * 1000;

async function loadCorpCodeList() {
  if (corpCodeCache && Date.now() - corpCodeCache.fetchedAt < CORP_CODE_TTL_MS) {
    return corpCodeCache.list;
  }
  const crtfc_key = getApiKey();
  const url = `${BASE}/corpCode.xml?crtfc_key=${crtfc_key}`;
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
  });
  if (!res.ok) throw new Error(`DART corpCode.xml HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const zip = new AdmZip(buf);
  const entry = zip.getEntries()[0];
  const xml = entry.getData().toString("utf-8");

  // 단순 XML 파싱 (의존성 최소화). 실제 응답 구조는 <list><corp_code>..</corp_code>
  // <corp_name>..</corp_name><corp_eng_name>..</corp_eng_name><stock_code>..</stock_code>
  // <modify_date>..</modify_date></list> 반복 (corp_eng_name 존재를 2026-07-25 실응답으로 확인)
  // — 태그 순서에 의존하지 않도록 블록 단위로 나눠 개별 태그를 추출한다.
  const list = [];
  const blockRe = /<list>([\s\S]*?)<\/list>/g;
  const field = (block, tag) => {
    const m = new RegExp(`<${tag}>([^<]*)<\\/${tag}>`).exec(block);
    return m ? m[1].trim() : "";
  };
  let block;
  while ((block = blockRe.exec(xml)) !== null) {
    const b = block[1];
    list.push({
      corp_code: field(b, "corp_code"),
      corp_name: field(b, "corp_name"),
      stock_code: field(b, "stock_code"),
      modify_date: field(b, "modify_date"),
    });
  }
  corpCodeCache = { list, fetchedAt: Date.now() };
  return list;
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

export async function searchCorpCode({ corp_name, stock_code, limit = 20 }) {
  if (!corp_name && !stock_code) {
    throw new Error("corp_name 또는 stock_code 중 하나는 필수입니다.");
  }
  const list = await loadCorpCodeList();

  if (stock_code) {
    const results = list.filter((c) => c.stock_code === stock_code);
    return { totalCount: results.length, items: results.slice(0, limit) };
  }

  // 3단계 매칭: ① 완전 부분일치 ② 초성 검색(query가 전부 초성일 때) ③ 약어 검색(부분수열).
  // 매칭 방식(tier)이 다르더라도, 상장사(종목코드 보유)는 실제 업무상 검색 의도일 가능성이
  // 높으므로 비상장 잡음 회사보다 우선 노출되도록 강한 가중치를 준다 — 예: "삼전"으로 검색
  // 시 상장 삼성전자(약어매칭)가 "삼전화학"·"삼전건설" 같은 비상장 정확매칭보다 먼저 뜨게 함.
  // 다만 tier 안에서는 정확도(부분일치 > 초성 > 약어) 순서를 그대로 유지한다.
  const needle = corp_name.trim();
  const needleIsChosung = isAllChosung(needle);
  const UNLISTED_PENALTY = 25;
  const scored = [];
  for (const c of list) {
    const name = c.corp_name;
    const listed = !!c.stock_code;
    let tier = null;
    let tie = 0;
    if (name.includes(needle)) {
      tier = 0;
      tie = name.length;
    } else if (needleIsChosung && getChosungString(name).includes(needle)) {
      tier = 1;
      tie = name.length;
    } else {
      const sub = subsequenceMatch(needle, name);
      if (sub) {
        tier = 2;
        tie = sub.span;
      }
    }
    if (tier === null) continue;
    const score = tier * 10 + (listed ? 0 : UNLISTED_PENALTY) + tie / 1000;
    scored.push({ c, score });
  }
  scored.sort((a, b) => a.score - b.score);
  const results = scored.map((s) => s.c);
  return { totalCount: results.length, items: results.slice(0, limit) };
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
};

export async function getFinancialStatement({
  infoType,
  corp_code,
  bsns_year,
  reprt_code,
  idx_cl_code,
  fs_div,
}) {
  const item = FINANCIAL_STATEMENT_ITEMS[infoType];
  if (!item) throw new Error(`알 수 없는 infoType: ${infoType}`);
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
