// dart-mcp / lib/server.js
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  searchDisclosure,
  getCompanyInfo,
  searchCorpCode,
  getPeriodicReportItem,
  PERIODIC_REPORT_ITEMS,
  getFinancialStatement,
  FINANCIAL_STATEMENT_ITEMS,
  getEquityDisclosure,
  EQUITY_DISCLOSURE_ITEMS,
  getMajorReportItem,
  MAJOR_REPORT_ITEMS,
  getSecuritiesReportItem,
  SECURITIES_REPORT_ITEMS,
} from "./dart_client.js";
import { formatDartResult } from "./format.js";

const periodicKeys = Object.keys(PERIODIC_REPORT_ITEMS);
const financialKeys = Object.keys(FINANCIAL_STATEMENT_ITEMS);
const equityKeys = Object.keys(EQUITY_DISCLOSURE_ITEMS);
const majorKeys = Object.keys(MAJOR_REPORT_ITEMS);
const securitiesKeys = Object.keys(SECURITIES_REPORT_ITEMS);

// 사람이 읽기 좋은 마크다운을 기본으로 반환한다. 원본 JSON 전문은 응답을 10배 이상
// 부풀려 토큰 낭비·가독성 저하가 실측으로 확인되어(2026-08-04 비교: 동일 질의 마크다운
// 약 2.6천 자 vs 마크다운+JSON 2.8만 자), include_raw=true를 명시한 호출에만 붙인다.
function textResult(obj, includeRaw = false) {
  const md = formatDartResult(obj);
  const text = includeRaw
    ? `${md}\n\n<details><summary>원본 JSON</summary>\n\n\`\`\`json\n${JSON.stringify(obj, null, 2)}\n\`\`\`\n\n</details>`
    : md;
  return { content: [{ type: "text", text }] };
}

// 모든 도구 공통 파라미터
const includeRawParam = {
  include_raw: z
    .boolean()
    .default(false)
    .describe("true면 마크다운 뒤에 원본 JSON 전문을 함께 반환 (기본 false, 후처리 필요시에만)"),
};

export function buildServer() {
  const server = new McpServer({ name: "dart-mcp", version: "1.0.0" });

  server.tool(
    "dart_search_disclosure",
    "DART 공시검색. 공시 유형·회사·날짜 등 조건으로 공시보고서를 검색합니다. corp_code가 " +
      "없으면 검색기간이 최근 3개월로 제한됩니다. pblntf_ty(A정기공시/B주요사항보고/C발행공시/" +
      "D지분공시/E기타공시/F외부감사/G펀드공시/H자산유동화/I거래소공시/J공정위공시)로 대분류 필터링 가능.",
    {
      corp_code: z.string().optional().describe("고유번호 8자리 (dart_search_corp_code로 확보)"),
      bgn_de: z.string().optional().describe("검색시작 접수일자 YYYYMMDD"),
      end_de: z.string().optional().describe("검색종료 접수일자 YYYYMMDD (기본값: 당일)"),
      last_reprt_at: z.enum(["Y", "N"]).optional().describe("최종보고서만 검색 (기본 N)"),
      pblntf_ty: z.string().optional().describe("공시유형 1자리: A~J"),
      pblntf_detail_ty: z.string().optional().describe("공시상세유형 4자리 코드"),
      corp_cls: z.enum(["Y", "K", "N", "E"]).optional().describe("Y유가/K코스닥/N코넥스/E기타"),
      sort: z.enum(["date", "crp", "rpt"]).optional(),
      sort_mth: z.enum(["asc", "desc"]).optional(),
      page_no: z.number().int().min(1).default(1),
      page_count: z.number().int().min(1).max(100).default(10),
      ...includeRawParam,
    },
    async (args) => textResult(await searchDisclosure(args), args.include_raw)
  );

  server.tool(
    "dart_get_company_info",
    "DART 기업개황 조회. 대표자명, 설립일, 상장일, 결산월, 업종, 주소, 홈페이지 등 기업 기본 " +
      "정보를 제공합니다. corp_code가 필요합니다 (모르면 dart_search_corp_code로 먼저 확보).",
    { corp_code: z.string().describe("고유번호 8자리"), ...includeRawParam },
    async (args) => textResult(await getCompanyInfo(args), args.include_raw)
  );

  server.tool(
    "dart_search_corp_code",
    "회사명 또는 종목코드로 DART 고유번호(corp_code)를 검색합니다. DART의 거의 모든 다른 " +
      "도구가 corp_code를 요구하므로, 회사명만 아는 경우 반드시 이 도구를 먼저 사용하세요. " +
      "부분일치 외에 약칭(삼전→삼성전자), 초성(ㅅㅅㅈㅈ→삼성전자), 오타 1~2자(삼성전지→" +
      "삼성전자)도 지원합니다. 상장사가 비상장 동명이사보다 우선 노출됩니다.",
    {
      corp_name: z.string().optional().describe("회사명 (부분일치·약칭·초성·오타보정 검색, 예: '포니링크', '삼전')"),
      stock_code: z.string().optional().describe("종목코드 6자리 (완전일치, corp_name보다 우선)"),
      limit: z.number().int().min(1).max(100).default(20),
      ...includeRawParam,
    },
    async (args) => textResult(await searchCorpCode(args), args.include_raw)
  );

  server.tool(
    "dart_get_periodic_report_item",
    "정기보고서(사업보고서/반기보고서/분기보고서) 주요정보 30종을 reportItem 하나로 통합" +
      "조회합니다(원본은 30개의 개별 오퍼레이션이나 이 도구가 통합). 최대주주 현황, 임원·직원 " +
      "현황, 배당, 자기주식, 증자·감자, 타법인출자, 감사인·감사의견, 이사·감사 보수현황 등. " +
      `사용 가능한 reportItem: ${periodicKeys.join(", ")}. ` +
      "reprt_code: 11013=1분기보고서, 11012=반기보고서, 11014=3분기보고서, 11011=사업보고서.",
    {
      reportItem: z.enum(periodicKeys),
      corp_code: z.string().describe("고유번호 8자리"),
      bsns_year: z.string().describe("사업연도 4자리 (예: 2025). 2015년 이후만 제공"),
      reprt_code: z.enum(["11013", "11012", "11014", "11011"]),
      ...includeRawParam,
    },
    async (args) => textResult(await getPeriodicReportItem(args), args.include_raw)
  );

  server.tool(
    "dart_get_financial_statement",
    "정기보고서 재무정보(XBRL 기반) 6종을 infoType 하나로 통합 조회합니다. single_account(단일" +
      "회사 주요계정)/multi_account(다중회사 주요계정, corp_code 콤마구분 최대100개)/" +
      "single_index(단일회사 주요 재무지표, idx_cl_code 필수)/multi_index(다중회사 주요 재무지표, " +
      "idx_cl_code 필수)/single_all(단일회사 전체 재무제표, fs_div 필수)/xbrl_taxonomy(XBRL " +
      "표준계정과목체계, sj_div만 필수·corp_code 불필요). 상장법인 및 주요 " +
      "비상장법인(사업보고서 제출대상+IFRS 적용)만 대상입니다.",
    {
      infoType: z.enum(financialKeys),
      corp_code: z
        .string()
        .optional()
        .describe("고유번호 8자리 (xbrl_taxonomy 외 필수. multi_*는 콤마로 여러 개, 예: '00126380,00164779')"),
      bsns_year: z.string().optional().describe("사업연도 4자리 (xbrl_taxonomy 외 필수)"),
      reprt_code: z.enum(["11013", "11012", "11014", "11011"]).optional().describe("xbrl_taxonomy 외 필수"),
      idx_cl_code: z
        .enum(["M210000", "M220000", "M230000", "M240000"])
        .optional()
        .describe("single_index/multi_index 필수: M210000수익성/M220000안정성/M230000성장성/M240000활동성"),
      fs_div: z.enum(["OFS", "CFS"]).optional().describe("single_all 필수: OFS=재무제표(개별), CFS=연결재무제표"),
      sj_div: z
        .string()
        .optional()
        .describe("xbrl_taxonomy 필수: BS1~BS4/IS1~IS4/CIS1~CIS4/DCIS1~DCIS5/CF1~CF4/SCE1~SCE2"),
      ...includeRawParam,
    },
    async (args) => textResult(await getFinancialStatement(args), args.include_raw)
  );

  server.tool(
    "dart_get_equity_disclosure",
    "지분공시 종합정보 2종을 infoType 하나로 통합 조회합니다. major_holding(대량보유 상황보고 " +
      "— 주식등의 5% 이상 대량보유자 현황)/exec_holding(임원·주요주주 소유보고 — 임원 및 주요" +
      "주주의 특정증권 소유상황). corp_code만 있으면 되고 날짜 필터는 없습니다(최근 보고서 기준).",
    {
      infoType: z.enum(equityKeys),
      corp_code: z.string().describe("고유번호 8자리"),
      ...includeRawParam,
    },
    async (args) => textResult(await getEquityDisclosure(args), args.include_raw)
  );

  server.tool(
    "dart_get_major_report_item",
    "주요사항보고서 주요정보 36종을 reportItem 하나로 통합 조회합니다(원본은 36개의 개별 " +
      "오퍼레이션). 부도발생/회생절차/해산/유상증자/무상증자/감자/소송/전환사채/신주인수권부" +
      "사채/교환사채/합병/분할/분할합병/주식교환이전/영업양수도/자산양수도/타법인주식양수도/" +
      "자기주식취득처분/자기주식취득신탁계약/해외상장폐지/채권은행관리절차/영업정지 등. " +
      `사용 가능한 reportItem: ${majorKeys.join(", ")}. ` +
      "corp_code + 조회기간(bgn_de~end_de, 접수일자 기준)이 모두 필수입니다.",
    {
      reportItem: z.enum(majorKeys),
      corp_code: z.string().describe("고유번호 8자리"),
      bgn_de: z.string().describe("검색시작 접수일자 YYYYMMDD"),
      end_de: z.string().describe("검색종료 접수일자 YYYYMMDD"),
      ...includeRawParam,
    },
    async (args) => textResult(await getMajorReportItem(args), args.include_raw)
  );

  server.tool(
    "dart_get_securities_report_item",
    "증권신고서 주요정보 6종을 reportItem 하나로 통합 조회합니다: reg_equity_securities(지분" +
      "증권)/reg_debt_securities(채무증권)/reg_depositary_receipts(증권예탁증권)/reg_merger(합병)/" +
      "reg_division(분할)/reg_stock_exchange_transfer(주식의포괄적교환·이전). corp_code + " +
      "조회기간(bgn_de~end_de, 접수일자 기준)이 모두 필수입니다.",
    {
      reportItem: z.enum(securitiesKeys),
      corp_code: z.string().describe("고유번호 8자리"),
      bgn_de: z.string().describe("검색시작 접수일자 YYYYMMDD"),
      end_de: z.string().describe("검색종료 접수일자 YYYYMMDD"),
      ...includeRawParam,
    },
    async (args) => textResult(await getSecuritiesReportItem(args), args.include_raw)
  );

  return server;
}
