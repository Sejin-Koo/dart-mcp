// parseRepresentatives 단위 검증.
// 입력은 이 대화에서 DART 원문 조회로 **실제로 관측한** 표지 문자열이다(지어낸 값 아님).
// 네트워크·자격증명 없이 파싱 로직만 검증한다.
import {
  parseRepresentatives,
  pickLatestExecutiveSet,
  repBasis,
  parseCeoNames,
  reconcileWithCompany,
  sameName,
} from "../lib/representatives.js";
import { formatDartResult } from "../lib/format.js";

const COVER = (company, title, names) =>
  `첨부된 재무제표는 당사가 작성한 것입니다. \n ${company} ${title} ${names} \n 본점 소재지 : \n (도로명주소) \n 서울시 구로구 디지털로26길 43 \n (전 화) \n 02-2025-4999 \n 재 무 상 태 표 `;

const CASES = [
  // ── 실측 표지 (2026-09-30 DART 원문 조회)
  { label: "㈜비디 FY2025 — 3인",            input: COVER("주식회사 비디", "대표이사", "김기용, 독고세준, 조성우"), expect: ["김기용", "독고세준", "조성우"] },
  { label: "㈜비디 FY2023 — 3인(제3자 상이)", input: COVER("주식회사 비디", "대표이사", "김기용, 독고세준, 이상명"), expect: ["김기용", "독고세준", "이상명"] },
  { label: "지엘케이에쿼티인베스트 — 2인",    input: COVER("주식회사 지엘케이에쿼티인베스트", "대표이사", "김상재, 황정일"), expect: ["김상재", "황정일"] },
  { label: "에어테크엔지니어링 — 자간 벌어짐", input: COVER("에어테크엔지니어링 주식회사", "대표이사", "김 도 영"), expect: ["김도영"] },
  { label: "쿠팡 — 외국인 성명 3토큰",        input: COVER("쿠팡 주식회사", "대표이사", "로저스 해롤드 린"), expect: ["로저스 해롤드 린"] },
  { label: "삼성웰스토리 — 회사명 붙여쓰기",  input: COVER("삼성웰스토리주식회사", "대표이사", "송규종"), expect: ["송규종"] },
  { label: "메가존클라우드 — 1인",            input: COVER("메가존클라우드 주식회사", "대표이사", "이주완"), expect: ["이주완"] },

  // ── 표기 변형 (서식이 흔들려도 견디는지)
  { label: "자간 벌어진 '본 점'",             input: COVER("주식회사 가나", "대표이사", "홍길동"). replace("본점", "본 점"), expect: ["홍길동"] },
  { label: "직명이 대표집행임원",             input: COVER("주식회사 다라", "대표집행임원", "김철수, 이영희"), expect: ["김철수", "이영희"] },
  { label: "쉼표 없이 가운뎃점",              input: COVER("주식회사 마바", "대표이사", "박민수·최지훈"), expect: ["박민수", "최지훈"] },

  // ── 음성 사례 (표지가 아닌 곳을 표지로 오인하면 안 됨)
  { label: "[음성] 주석의 연대보증 문장",     input: "당사의 차입금등과 관련하여 당사 대표이사로부터 지급(연대)보증을 제공받고 있습니다. 본점 이전 계획은 없습니다.", expect: null },
  { label: "[음성] 표지 블록 없음",           input: "감사의견 우리는 주식회사 비디의 재무제표를 감사하였습니다. 대표이사 귀하", expect: null },
];

let pass = 0, fail = 0;
const check = (label, ok, extra) => {
  console.log(`${ok ? "  OK " : "  !! "} ${label}`);
  if (!ok && extra) console.log(`       ${extra}`);
  ok ? pass++ : fail++;
};

console.log("── 성명 파싱");
for (const c of CASES) {
  const got = parseRepresentatives(c.input);
  const names = got ? got.names : null;
  check(
    c.label,
    JSON.stringify(names) === JSON.stringify(c.expect),
    `기대 ${JSON.stringify(c.expect)} / 실제 ${JSON.stringify(names)}`
  );
}

// ── 표지상_회사명: 직전 문장이 섞여 들어오지 않아야 한다
// (실측 불량값: '2024년 12월 31일 까지 "첨부된 재무제표는 당사가 작성한 것입니다." 주식회사 비디')
console.log("\n── 표지상 회사명");
const COMPANY_CASES = [
  ["주식회사 비디", "주식회사 비디"],
  ["에어테크엔지니어링 주식회사", "에어테크엔지니어링 주식회사"],
  ["삼성웰스토리주식회사", "삼성웰스토리주식회사"],
  ["㈜비디", "㈜비디"],
  ["쿠팡 주식회사", "쿠팡 주식회사"],
];
for (const [company, expect] of COMPANY_CASES) {
  const got = parseRepresentatives(COVER(company, "대표이사", "홍길동"));
  check(
    `${company} → ${expect}`,
    got && got.companyHint === expect,
    `실제 ${JSON.stringify(got && got.companyHint)}`
  );
}

// ── 마크다운 렌더: 중첩 객체·객체 배열이 "[object Object]"로 찍히지 않아야 한다
console.log("\n── 중첩 값 렌더");
const NESTED = {
  corp_code: "01447800",
  조회됨: true,
  대표이사: ["김기용", "독고세준", "조성우"],
  인원수: 3,
  상세: [
    { 성명: "김기용", 직위: "대표이사", 재직기간: "2017.03.28~현재", 임기만료일: "2027.03.27" },
    { 성명: "독고세준", 직위: "대표이사", 재직기간: "2021.03.26~현재", 임기만료일: "2027.03.25" },
  ],
  출처: { 경로: "사업보고서 임원현황", 사업연도: "2024", 접수번호: "20250331001234" },
  caveats: [
    "사업보고서 임원현황 기재 기준입니다. 해당 사업연도 말 시점이므로 이후의 변동은 반영되지 않습니다.",
    "각자대표인지 공동대표인지는 임원현황에 기재되지 않습니다.",
  ],
};
const md = formatDartResult(NESTED);
check("[object Object]가 없다", !md.includes("[object Object]"));
check("객체 배열이 하위 표로 나온다", md.includes("**상세**") && md.includes("2017.03.28~현재"));
check("중첩 객체가 한 줄로 펼쳐진다", md.includes("접수번호: 20250331001234"));
check("긴 배열은 목록으로 떨어진다", /\*\*유의사항\*\*\n\n- /.test(md));
check("짧은 배열은 셀에 그대로 들어간다", md.includes("김기용 · 독고세준 · 조성우"));

// 값에 든 파이프가 열을 깨뜨리지 않아야 한다
check(
  "셀 안의 | 는 이스케이프된다",
  formatDartResult({ 비고: "가|나" }).includes("가\\|나"),
  formatDartResult({ 비고: "가|나" })
);

// ── 임원현황 후보 중 결산기준일이 가장 최근인 보고서를 고르는가
console.log("\n── 최신 보고서 선택");
const EX = (stlm, rcept, ofcps = "대표이사", nm = "황정일") => ({
  nm, ofcps, stlm_dt: stlm, rcept_no: rcept, corp_name: "포니링크",
});

// 실측(2026-09-30): 사업보고서만 보면 6개월 묵은 명단이 나온다
const 사업2025 = { year: 2025, code: "11011", list: [EX("2025-12-31", "20260318000966")] };
const 반기2026 = { year: 2026, code: "11012", list: [EX("2026-06-30", "20260814003964")] };
check(
  "반기보고서가 더 최근이면 그쪽을 고른다",
  pickLatestExecutiveSet([사업2025, 반기2026])?.code === "11012"
);
check(
  "입력 순서가 바뀌어도 결과가 같다",
  pickLatestExecutiveSet([반기2026, 사업2025])?.code === "11012"
);

// 12월 결산이 아닌 회사 — 보고서 종류로 순서를 가정하면 틀린다
check(
  "3월 결산사는 사업보고서가 같은 해 반기보다 최근일 수 있다",
  pickLatestExecutiveSet([
    { year: 2026, code: "11012", list: [EX("2025-09-30", "20251114000001")] },
    { year: 2025, code: "11011", list: [EX("2026-03-31", "20260630000001")] },
  ])?.code === "11011"
);

// 표기 흔들림 — "2026년 06월 30일"과 "2026-06-30"은 같은 날이다
check(
  "결산기준일 표기가 달라도 같은 날로 비교한다",
  pickLatestExecutiveSet([
    { year: 2026, code: "11012", list: [EX("2026년 06월 30일", "20260814003964")] },
    { year: 2025, code: "11011", list: [EX("2025-12-31", "20260318000966")] },
  ])?.code === "11012"
);

// 기준일이 같으면 나중에 제출된 쪽(정정보고서 등)
check(
  "기준일이 같으면 접수번호가 큰 쪽",
  pickLatestExecutiveSet([
    { year: 2025, code: "11011", list: [EX("2025-12-31", "20260318000966")] },
    { year: 2025, code: "11011", list: [EX("2025-12-31", "20260520000111")] },
  ])?.rcept === "20260520000111"
);

check(
  "대표 직위가 없으면 고르지 않는다",
  pickLatestExecutiveSet([
    { year: 2025, code: "11011", list: [EX("2025-12-31", "1", "사외이사", "이익우")] },
  ]) === null
);
check("빈 입력은 null", pickLatestExecutiveSet([]) === null && pickLatestExecutiveSet() === null);
check(
  "각자대표·대표집행임원도 대표로 잡는다",
  pickLatestExecutiveSet([
    { year: 2025, code: "11011", list: [EX("2025-12-31", "1", "각자대표이사"), EX("2025-12-31", "1", "대표집행임원", "김철수")] },
  ])?.reps.length === 2
);

// ── 담당업무 칸의 대표이사 (실측 2026-11-16 DART 임원현황)
console.log("\n── 담당업무 칸 · 직급만으로는 인정 안 함");
const P = (nm, ofcps, rgist, chrg) => ({ nm, ofcps, rgist_exctv_at: rgist, chrg_job: chrg });
const BASIS = [
  // 팅크웨어 2025 사업보고서·2026 반기: 직위 '사장', 담당업무에 대표이사
  ["팅크웨어 2025 — 담당업무 '대표이사, …'", P("이흥복", "사장", "사내이사", "대표이사, 전사 경영 전반 총괄"), "담당업무"],
  ["팅크웨어 2026 반기 — 담당업무 '대표이사 …'", P("이흥복", "사장", "사내이사", "대표이사 전사 경영 전반 총괄"), "담당업무"],
  // 삼성전자 2026 반기
  ["삼성전자 전영현 — 'ㆍ대표이사 (DS부문…)'", P("전영현", "부회장", "사내이사", "ㆍ대표이사   (DS부문 경영전반 총괄)"), "담당업무"],
  ["[음성] 삼성전자 김용관 — 등기 사장이지만 대표 아님", P("김용관", "사장", "사내이사", "ㆍDS부문 경영전략총괄"), null],
  ["[음성] 삼성전자 노태문 — 반기 임원현황엔 표시 없음", P("노태문", "사장", "사내이사", "ㆍDX부문장 직무대행ㆍMX사업부장"), null],
  ["직위에 대표 — 기존 방식 유지", P("황정일", "대표이사", "사내이사", "경영총괄"), "직위"],
  ["대표집행임원은 미등기여도 인정", P("김철수", "사장", "미등기", "대표집행임원"), "담당업무"],
  ["[음성] 대표이사를 꾸미는 말 — 직속", P("박감사", "상무", "사내이사", "대표이사 직속 감사실장"), null],
  ["[음성] 대표이사 비서실장", P("최비서", "이사", "사내이사", "대표이사 비서실장"), null],
  ["[음성] 대표이사실", P("정실장", "상무", "사내이사", "대표이사실 총괄"), null],
  ["[음성] 미등기 임원의 '대표이사…' 표기", P("한미등", "전무", "미등기", "대표이사 겸 사업부장"), null],
  ["[음성] 담당업무 중간의 대표이사(앞에 다른 말)", P("오중간", "사장", "사내이사", "자회사 대표이사 겸임"), null],
  ["각자대표이사로 시작", P("윤각자", "부사장", "사내이사", "각자대표이사 / 영업총괄"), "담당업무"],
];
for (const [label, row, expect] of BASIS) {
  const got = repBasis(row);
  check(label, got === expect, `기대 ${expect} / 실제 ${got}`);
}

// 팅크웨어 재현: 2024 사업보고서만 직위에 '대표 이사'. 예전에는 이 보고서로 내려갔다.
const TW = (stlm, rcept, ofcps, chrg) => ({ nm: "이흥복", ofcps, rgist_exctv_at: "사내이사", chrg_job: chrg, stlm_dt: stlm, rcept_no: rcept });
const tw = pickLatestExecutiveSet([
  { year: 2024, code: "11011", list: [TW("2024-12-31", "20250319001133", "대표 이사", "전사 경영 전반 총괄")] },
  { year: 2025, code: "11011", list: [TW("2025-12-31", "20260320001267", "사장", "대표이사, 전사 경영 전반 총괄")] },
  { year: 2026, code: "11012", list: [TW("2026-06-30", "20260814000001", "사장", "대표이사 전사 경영 전반 총괄")] },
]);
check("팅크웨어 — 2026 반기 보고서를 고른다", tw?.code === "11012" && tw?.year === 2026, JSON.stringify(tw && { y: tw.year, c: tw.code }));
check("팅크웨어 — 최신 보고서와 같으면 stale 아님", tw?.latest?.stlm === tw?.stlm);

// 최근 보고서에 대표 표시가 없으면 latest가 best보다 최근으로 남는다(경고 근거)
const st = pickLatestExecutiveSet([
  { year: 2025, code: "11011", list: [TW("2025-12-31", "1", "대표이사", "경영총괄")] },
  { year: 2026, code: "11012", list: [TW("2026-06-30", "2", "사장", "경영총괄")] },
]);
check("최근 보고서에 대표 표시가 없으면 latest가 더 최근", st?.stlm === "20251231" && st?.latest?.stlm === "20260630");

// ── 기업개황 대표자명 대조
console.log("\n── 기업개황 대조");
check("ceo_nm 쉼표 2명", JSON.stringify(parseCeoNames("전영현, 노태문").names) === '["전영현","노태문"]');
check("ceo_nm 괄호·직명 제거", JSON.stringify(parseCeoNames("홍길동(각자대표), 김철수").names) === '["홍길동","김철수"]');
check("ceo_nm '외 1명' → partial", parseCeoNames("홍길동 외 1명").partial === true && parseCeoNames("홍길동 외 1명").names[0] === "홍길동");
check("ceo_nm 빈 값", parseCeoNames("").names.length === 0);
const rc = reconcileWithCompany(["전영현"], ["전영현", "노태문"]);
check("삼성전자 — 기업개황에만 노태문", JSON.stringify(rc.기업개황에만) === '["노태문"]' && rc.임원현황에만.length === 0);
const rc2 = reconcileWithCompany(["김기용", "독고세준", "조성우"], ["김기용"]);
check("비디 — 임원현황에만 2명", rc2.임원현황에만.length === 2 && rc2.일치[0] === "김기용");
const hy = reconcileWithCompany(["정의선", "호세 무뇨스", "최영일"], parseCeoNames("정의선, 무뇨스 바르셀로 호세 안토니오, 최영일(각자 대표이사)").names);
check("현대자동차 — 외국인 성명 표기 차이는 같은 사람", hy.일치.length === 3 && hy.기업개황에만.length === 0 && hy.임원현황에만.length === 0 && hy.표기차이?.length === 1, JSON.stringify(hy));
check("[음성] 낱말 하나만 같으면 다른 사람", sameName("호세", "호세 안토니오") === false && sameName("김철수", "김철호") === false);
check("공백 차이는 같은 사람", reconcileWithCompany(["김 도 영"], ["김도영"]).일치.length === 1);

// ── 필드 라벨 — 임원현황은 tenure_end_dt가 아니라 tenure_end_on을 쓴다
console.log("\n── 임원현황 필드 라벨");
const execMd = formatDartResult({
  list: [{ nm: "황정일", ofcps: "대표이사", rgist_exctv_at: "사내이사", fte_at: "상근",
           chrg_job: "경영총괄", hffc_pd: "2017.03.28~현재", tenure_end_on: "2027년 03월 15일" }],
});
for (const raw of ["rgist_exctv_at", "fte_at", "tenure_end_on"]) {
  check(`${raw}가 영문 그대로 찍히지 않는다`, !execMd.includes(raw), execMd);
}
check("등기임원여부·상근여부·임기만료일 라벨이 나온다",
  ["등기임원여부", "상근여부", "임기만료일"].every((k) => execMd.includes(k)), execMd);

console.log(`\n통과 ${pass} / 실패 ${fail} (전체 ${pass + fail})`);
process.exit(fail ? 1 : 0);
