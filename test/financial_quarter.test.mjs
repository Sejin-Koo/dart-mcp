import { toFinancialMarkdown } from "../lib/format.js";
const base = { fs_nm: "연결재무제표", rcept_no: "1", currency: "KRW" };
const rows = [
  { ...base, sj_div: "BS", sj_nm: "재무상태표", account_nm: "자산총계", thstrm_nm: "제 47 기반기말", thstrm_dt: "2026.06.30 현재", thstrm_amount: "231", frmtrm_nm: "제 46 기말", frmtrm_amount: "237" },
  { ...base, sj_div: "IS", sj_nm: "손익계산서", account_nm: "매출액", thstrm_nm: "제 47 기반기", thstrm_dt: "2026.01.01 ~ 2026.06.30", thstrm_amount: "59", thstrm_add_amount: "116", frmtrm_nm: "제 46 기반기", frmtrm_dt: "2025.01.01 ~ 2025.06.30", frmtrm_amount: "51", frmtrm_add_amount: "102" },
];
const q = toFinancialMarkdown(rows); console.log(q);
const annual = toFinancialMarkdown(rows.map(r => { const x = { ...r }; delete x.thstrm_add_amount; delete x.frmtrm_add_amount; return x; }));
console.log("----\n" + annual);
if (!/당기 누적 \| 당기 3개월/.test(q) || !/\| 116 \| 59 \| 102 \| 51 \|/.test(q) || /누적/.test(annual)) { console.log("FAIL"); process.exit(1); }
console.log("PASS");
