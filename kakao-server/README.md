# CourtSync 카카오 연결 서버

GitHub Pages는 정적 호스팅이므로 카카오의 클라이언트 시크릿을 보관할 수 없습니다.
이 Worker는 OAuth 로그인, 암호화된 단기 세션, 기존 일정 확인 후 일정 생성을 담당합니다.
Google→카카오 백그라운드 동기화가 아니라, 사용자가 선택한 예약을 각각 등록합니다.

## 처음 한 번 설정

1. https://developers.kakao.com 에서 CourtSync 앱을 생성하고 카카오 로그인을 활성화합니다.
2. 동의항목 `talk_calendar`(톡캘린더 및 일정 생성, 조회, 편집/삭제)를 선택 동의로 설정합니다.
   본인 카카오계정은 앱 멤버로 테스트할 수 있습니다. 일반 사용자에게 제공하려면 별도 사용 권한 신청이 필요합니다.
3. Cloudflare Workers에서 이 폴더의 `worker.mjs`를 배포합니다. CLI 사용 시 이 폴더에서 `npx wrangler deploy`를 실행합니다.
4. Worker의 Settings → Variables and Secrets에서 다음을 Secret으로 등록합니다.
   - `KAKAO_REST_KEY`: 앱 REST API 키
   - `KAKAO_CLIENT_SECRET`: 카카오 로그인 클라이언트 시크릿
   - `SESSION_SECRET`: 비밀번호 관리기로 생성한 32자 이상의 무작위 문자열
   위 값은 GitHub나 CourtSync 입력창 또는 대화에 붙여넣지 마세요.
5. 일반 변수 `APP_ORIGIN`을 `https://eunseonkim-png.github.io`로 설정합니다.
6. 발급된 Worker 주소가 `https://courtsync-kakao.example.workers.dev`라면 카카오 로그인 Redirect URI에
   `https://courtsync-kakao.example.workers.dev/callback`을 등록합니다.
7. CourtSync의 ‘처음 한 번 카카오 연결 설정’에 Worker의 HTTPS 주소만 저장합니다.
8. 카카오 연결 → Google 연결 → 예약 선택 → Google·카카오 함께 등록을 누릅니다.

## 동작과 범위

- 로그인은 팝업을 사용합니다. 모바일 Safari에서 팝업을 허용해야 할 수 있습니다.
- 액세스 토큰과 갱신 토큰을 로컬 저장소·쿠키에 저장하지 않습니다. Worker가 암호화한 단기 세션은 브라우저 메모리에만 유지됩니다.
- 로그인 콜백은 state와 HttpOnly 쿠키를 비교합니다. POST는 지정된 앱 원본만 허용합니다.
- 각 일정은 등록 전 같은 제목·시간의 서비스 일정을 조회합니다. 다음 페이지까지 확인할 수 없으면 생성하지 않습니다.
- 등록 요청의 응답이 불확실하면 자동 재전송하지 않습니다. 다시 눌렀을 때 기존 일정을 먼저 확인합니다.
- 다른 기기/탭에서 동시에 같은 예약을 등록하지 마세요. 카카오 생성 API에는 멱등 키가 없어 동시 요청은 중복을 만들 수 있습니다.
- 생성 후 상세 조회로 제목·시간을 확인한 일정만 완료로 표시합니다.
- 기존 Google 일정만 자동으로 읽거나 취소/변경을 양쪽에 전파하지 않습니다. 기존 예약목록을 선택해 카카오에도 추가할 수 있습니다.
- 연결 서버 주소 및 카카오 앱 설정 없이는 실제 일정 등록이 동작하지 않습니다.

공식 문서: https://developers.kakao.com/docs/ko/talkcalendar/common
