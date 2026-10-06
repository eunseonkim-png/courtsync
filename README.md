# CourtSync

강동구 테니스 예약목록을 복사해 캘린더 일정으로 옮기는 모바일 웹앱입니다.

앱: https://eunseonkim-png.github.io/courtsync/

## v0.4.0

- 앱 새로고침 버튼: 서비스 워커 업데이트를 확인하고 최신 앱을 엽니다. 저장한 예약목록과 등록 기록은 유지합니다.
- 휴대폰 Google 일괄 등록: Google 계정을 연결한 뒤 체크한 예약을 기본 캘린더에 직접 추가합니다.
- 기존 수동/ICS CourtSync 일정도 제목·시작·종료 시간을 비교해 중복 등록을 피합니다.
- 일정별 고정 ID를 사용해 서버가 저장한 뒤 응답이 끊긴 경우에도 재시도로 중복 생성하지 않습니다.
- 성공한 예약만 Google 등록완료로 표시합니다. 실패한 예약은 재시도할 수 있도록 선택 상태를 유지합니다.
- Google 로그인 토큰은 메모리에만 두며 localStorage, 서비스 워커 또는 저장소에 저장하지 않습니다.

## Google 최초 연결 설정

현재 배포본에는 아직 사용자 앱의 Google OAuth 클라이언트 ID가 없습니다. **구현은 완료됐지만 실제 계정 등록을 사용하려면 이 설정과 Google 동의가 필요합니다.** 연결 ID는 공개 값이며 보안 비밀번호가 아닙니다.

1. [Google Cloud](https://console.cloud.google.com/)에서 CourtSync 프로젝트를 만듭니다.
2. API 및 서비스 → 라이브러리 → Google Calendar API를 사용 설정합니다.
3. Google Auth Platform에서 브랜딩의 앱 이름, 지원 이메일, 개발자 연락처를 설정합니다.
4. 잠재고객을 외부(External), 테스트(Testing)로 설정하고 본인 Gmail을 테스트 사용자로 추가합니다.
5. 데이터 액세스에 아래 두 권한을 추가합니다.
   - `https://www.googleapis.com/auth/calendar.events.owned`
   - `https://www.googleapis.com/auth/calendar.calendars.readonly`
6. 클라이언트 → 클라이언트 만들기 → 웹 애플리케이션을 선택합니다.
7. 승인된 JavaScript 원본에 `https://eunseonkim-png.github.io`를 추가합니다. `/courtsync/` 경로는 포함하지 않습니다. 팝업 토큰 방식이므로 리디렉션 URI는 필요하지 않습니다.
8. 발급된 `.apps.googleusercontent.com` 클라이언트 ID를 앱의 ‘처음 한 번 연결 설정’에 입력합니다. 또는 공개 ID만 `config.js`에 설정합니다.
9. 앱에서 Google 계정을 연결해 캘린더 접근에 동의하고, 실제 예약 한 건으로 먼저 확인합니다.

클라이언트 보안 비밀번호, 비밀번호, 액세스 토큰을 코드나 GitHub에 넣지 마세요. 테스트 모드에서는 등록된 테스트 사용자만 사용합니다. 불특정 사용자에게 공개할 때는 Google OAuth 정책에 맞는 별도 검증이 필요할 수 있습니다.

## v0.3.0에서 유지한 기능

- JavaScript 구문 오류와 잘못된 PWA manifest를 수정했습니다.
- 결제완료 예약을 추출하며 중복, 취소, 잘못된 날짜와 시간을 제외합니다.
- 추출한 목록과 등록 이력을 기기에 저장합니다. 붙여넣은 원문은 저장하지 않습니다.
- Google 일정 작성 창에서 저장한 뒤 사용자가 확인하면 등록완료로 표시합니다.
- 선택한 예약을 .ics 파일로 내보냅니다. 등록완료 예약은 기본 선택에서 제외합니다.
- 한국 시간을 UTC로 변환합니다. ICS에는 고정 UID, DTSTAMP, CRLF 및 UTF-8 줄 접기를 적용합니다.
- 홈 화면 아이콘과 오프라인 예약목록 조회를 지원합니다.

## 사용 방법

1. 강동구 마이페이지의 예약목록 표 전체를 복사해서 붙여넣습니다.
2. 예약을 추출하고 날짜, 시간, 코트가 정확한지 확인합니다.
3. Google 계정을 연결하고 등록할 예약을 체크합니다.
4. ‘Google에 자동 등록’을 누르면 저장하거나 기존 등록을 확인한 예약이 초록색으로 바뀝니다.

여러 예약은 원하는 항목을 선택해 .ics 파일로 내보낼 수 있습니다. Google 캘린더의 파일 가져오기는 컴퓨터에서 지원합니다. 파일을 내보내는 것만으로 일정이 저장되지는 않습니다.

개별 Google 일정 작성 창과 ICS 파일 내보내기도 사용할 수 있습니다. 이 경우 ‘저장했어요’는 사용자의 확인 기록입니다. Google 일괄 등록의 ‘Google 등록완료’는 API 응답으로 저장 상태를 확인한 기록입니다. 예약 취소·시간 변경의 자동 반영은 지원하지 않으며 앱에서 기존 Google 일정의 시간을 자동으로 덮어쓰지 않습니다.

표를 다시 추출하면 현재 목록은 새로 붙여넣은 표로 바뀌고 등록 이력은 유지됩니다. 기기나 브라우저 사이의 기록 공유는 지원하지 않습니다. 파서는 여러 복사 형식을 지원하지만 실제 사이트의 열 순서가 바뀌면 추출 결과를 확인해야 합니다.

## 개발 및 검증

빌드나 외부 라이브러리 없이 정적 파일로 동작합니다. Node.js 18 이상에서:

```sh
node --check app.js
node --check sw.js
node --check google-calendar.js
node --test tests/*.test.cjs
python3 -m json.tool manifest.json
```

저장소의 상위 폴더에서 `python3 -m http.server 8080` 실행 후 `http://localhost:8080/courtsync/`에서 확인합니다. 서비스 워커를 변경할 때는 캐시 이름과 자산 버전도 함께 갱신합니다.

## 카카오 톡캘린더 검토

카카오 일정 등록은 불가능한 기능이 아닙니다. 공식 톡캘린더 API의 `POST /v2/api/calendar/create/event`로 로그인한 사용자의 기본 캘린더에 일반 일정을 만들 수 있습니다. `talk_calendar` 동의, 카카오 로그인 앱 설정과 리디렉트 URI 등록이 필요합니다.

사용 권한이 없는 앱/테스트 앱에서도 앱 멤버에 한정해 호출할 수 있으므로, 본인만 쓰는 개인용 앱은 해당 범위에서 구현·테스트할 수 있습니다. 일반 사용자에게 제공하려면 톡캘린더 사용 권한을 신청해야 합니다. 공개 일정용 카카오톡 채널 연결은 개인 일반 일정 생성과 다른 조건입니다.

이번 버전에는 Google 일괄 등록을 구현했으며 카카오 등록 코드는 아직 넣지 않았습니다. 카카오를 추가할 때는 로그인 및 토큰 교환을 안전하게 처리하는 별도 연동을 구성하고, CourtSync가 각 캘린더 API에 따로 등록하도록 구현할 수 있습니다. Google 일정이 자동으로 카카오로 복제되는 기능을 가정하지 않습니다.

참고: [Google 토큰 방식](https://developers.google.com/identity/oauth2/web/guides/use-token-model), [Google 이벤트 생성](https://developers.google.com/workspace/calendar/api/v3/reference/events/insert), [카카오 톡캘린더 사용 방법](https://developers.kakao.com/docs/ko/talkcalendar/common), [카카오 일정 생성](https://developers.kakao.com/docs/ko/talkcalendar/rest-api), [iCalendar RFC 5545](https://www.rfc-editor.org/rfc/rfc5545.html).
