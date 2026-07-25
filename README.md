# dart-mcp

OpenDART(금융감독원 전자공시시스템) 오픈API를 감싼 MCP 서버입니다. 인증키는 URL이 아니라
Vercel 환경변수(`DART_API_KEY`)로만 보관하므로, 이 MCP의 엔드포인트 URL을 다른 사람과
공유해도 인증키는 노출되지 않습니다.

## 배경

기존에 연결해서 쓰던 DART MCP는 제3자(마켓플레이스) 호스팅 서버로, 연결 URL 자체에
개인 인증키가 쿼리 파라미터로 포함되는 구조였습니다. 그 URL이 곧 인증수단이라 URL을
공유하는 순간 키도 함께 노출되는 문제가 있어, 다른 자체 구축 MCP(public-data-portal-mcp,
kipris-mcp, fss-corp-info-mcp)와 동일한 패턴(서버 env var 보관)으로 새로 만들었습니다.

## 엔드포인트

```
https://dart-mcp.vercel.app/api/mcp
```

(실제 배포 URL은 Vercel 프로젝트 생성 시 확정됩니다. 다르면 실제 URL로 교체하세요.)

인증 불필요 (서버가 자체적으로 `DART_API_KEY` 환경변수 보유).

## 환경변수 (Vercel)

```
DART_API_KEY=faba5fc9612a3ce6f7b87364ae43f50a464eb4c6
```

## 설계 방침

OpenDART 공식 API는 6개 카테고리(DS001~DS006)에 총 85개 엔드포인트로 구성되어 있습니다
(2026-07-25 opendart.fss.or.kr/guide 공식 문서 전수 확인). 이를 85개의 개별 MCP 도구로
노출하는 대신, fss-corp-info-mcp에서 효과가 좋았던 "카테고리 통합 + enum 파라미터" 패턴을
적용해 8개 도구로 재구성했습니다. 문서 원본 4자리 파일 다운로드(document.xml, corpCode.xml
원본, XBRL 원본파일 등 바이너리 응답)는 JSON 데이터 조회 목적과 맞지 않아 라이브 도구로는
제외했습니다(단, corpCode.xml은 회사명 검색 기능 내부 구현에 활용).

## 제공 도구 (8개)

1. **dart_search_disclosure** — 공시검색 (list.json). 공시유형·회사·날짜로 검색.
2. **dart_get_company_info** — 기업개황 (company.json). 대표자·설립일·업종 등.
3. **dart_search_corp_code** — 회사명/종목코드로 고유번호(corp_code) 검색. corpCode.xml
   전체 목록(zip)을 서버가 캐싱(24시간 TTL)해서 부분일치 검색.
4. **dart_get_periodic_report_item** — 정기보고서 주요정보 30종 통합(DS002). 최대주주·
   임원·직원 현황, 배당, 자기주식, 증자·감자, 감사인·감사의견, 이사·감사 보수 등.
   `corp_code + bsns_year + reprt_code` 필수.
5. **dart_get_financial_statement** — 정기보고서 재무정보 5종 통합(DS003). 단일/다중회사
   주요계정·재무지표, 단일회사 전체 재무제표.
6. **dart_get_equity_disclosure** — 지분공시 종합정보 2종 통합(DS004). 대량보유상황보고,
   임원·주요주주 소유보고. `corp_code`만 필요.
7. **dart_get_major_report_item** — 주요사항보고서 주요정보 36종 통합(DS005). 부도·회생·
   해산·유상증자·무상증자·감자·소송·전환사채·합병·분할·영업양수도·자기주식 등.
   `corp_code + bgn_de + end_de` 필수.
8. **dart_get_securities_report_item** — 증권신고서 주요정보 6종 통합(DS006). 지분증권·
   채무증권·증권예탁증권·합병·분할·주식교환이전.

## 검증 이력 (2026-07-25)

- 85개 엔드포인트 전체를 opendart.fss.or.kr/guide 공식 문서에서 bash curl로 실시간
  스크래핑하여 URL 슬러그를 확보(추측 없음). 카테고리별 파라미터 패턴도 공식 문서에서
  직접 확인:
  - DS002(정기보고서 주요정보): `corp_code + bsns_year + reprt_code`
  - DS003(정기보고서 재무정보): 위 3개 + 항목별 `idx_cl_code`(지표) 또는 `fs_div`(전체
    재무제표)
  - DS004(지분공시): `corp_code`만
  - DS005(주요사항보고서), DS006(증권신고서): `corp_code + bgn_de + end_de`
- 실제 인증키로 로컬 스모크테스트 완료: `dart_search_corp_code`(포니링크→corp_code
  00392691 확인, 기존 스킬의 하드코딩 값과 일치. 젬백스인베스트 corp_code 01915356도
  확인), `dart_get_company_info`(삼성전자), `dart_search_disclosure`(삼성전자 최근
  공시), `dart_get_periodic_report_item`(최대주주 현황), `dart_get_financial_statement`
  (단일회사 주요계정), `dart_get_equity_disclosure`(대량보유상황보고),
  `dart_get_major_report_item`(자기주식취득결정), `dart_get_securities_report_item`
  (013 NODATA 정상 처리 확인) — 8개 도구 모두 실데이터로 확인.

## 발견한 quirk

- **corpCode.xml 파싱**: 실제 응답에 `<corp_eng_name>` 태그가 `<corp_name>`과
  `<stock_code>` 사이에 존재해서, 태그 순서 고정 정규식으로 파싱하면 전부 매치 실패함
  (최초 구현에서 실제로 발생 — 모든 검색이 0건으로 나왔음). `<list>...</list>` 블록
  단위로 나눈 뒤 태그별로 독립 추출하도록 수정.
- **status 013 = NODATA**: OpenDART 공통 관례상 013(조회된 데이터가 없습니다)은 실패가
  아니라 정상 무응답이므로 `{totalCount:0, items:[]}`로 정규화.
- DART API는 이 생태계의 다른 공공데이터포털 API들과 달리 응답 스키마가 매우 일관적
  (`{status, message, list?}` 단일 구조)이라 별도의 복잡한 정규화 분기가 필요 없었음.

## 현재 상태 (2026-07-25)

코드는 완성되고 로컬 스모크테스트까지 마쳤으나, 사용자 요청으로 **GitHub push까지만 진행하고
Vercel 배포·Settings 등록·관련 스킬(dart-disclosure-lookup) 전환은 보류** 중입니다. 기존에
쓰던 제3자 호스팅 DART MCP는 그대로 유지되며 이 서버 완성과 무관하게 정상 작동합니다.
실제로 전환하고 싶을 때 이 저장소를 기반으로 Vercel 배포 → 환경변수(DART_API_KEY) 등록 →
Settings에 엔드포인트 등록 → dart-disclosure-lookup 스킬 업데이트 순으로 진행하면 됩니다.

## 향후 개선 후보

- **회사명 검색 랭킹 고도화**: 현재 `dart_search_corp_code`는 상장 여부(종목코드 유무)만
  가중치로 반영하는데, corpCode.xml에는 시가총액·거래대금 같은 "인지도" 정보가 없어서
  동률 상장사들 사이에서 원하는 회사가 항상 1위로 뜨지는 않는다(예: "삼전" 검색 시 삼성전기·
  삼화전기 등과 삼성전자가 뒤섞임, 2026-07-25 확인). KRX 시가총액/거래대금 데이터
  (`market-macro-data-lookup` 스킬의 KRX API 또는 별도 KRX MCP)를 결합해서 랭킹에
  추가 가중치를 주면 기존 제3자 DART MCP 수준의 검색 품질에 더 가까워질 것으로 예상.
- **응답 포맷 세밀화**: 현재 `lib/format.js`는 모든 필드를 보여주는 범용 마크다운 표
  방식인데, 자주 쓰는 도구(최대주주현황, 배당, 임원현황 등)부터 기존 제3자 MCP처럼
  꼭 필요한 열만 골라 보여주도록 도구별 커스텀 컬럼 선택 로직을 추가하면 가독성이
  더 좋아질 것.
- **문서 원본파일 지원**: 공시서류 원본파일(document.xml), XBRL 재무제표 원본파일
  (fnlttXbrl.xml) 다운로드는 바이너리 응답이라 이번 범위에서 제외했음. 필요해지면
  Base64 인코딩 등으로 별도 도구를 추가할 수 있음.

## 이 서버가 하지 않는 것

- 공시서류 원본파일(document.xml), corpCode.xml 원본 파일, XBRL 재무제표 원본파일 등
  바이너리/파일 다운로드 자체를 반환하는 기능. corpCode.xml만 예외적으로 서버 내부에서
  회사명 검색 인덱스로 활용.
- 개인정보 성격의 세부 항목(이사·감사 개인별 보수 5억 이상 등)은 원본 API가 제공하는
  그대로 반환하되, 별도 마스킹/가공은 하지 않음.
