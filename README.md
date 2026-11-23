# DARK CODE Orchestrator

로컬 Ollama 전문가 AI 6종을 자동 배정 → 초안 → 검수 → 수정 루프로 돌리는 멀티 에이전트 오케스트레이터.

Live: https://jake12733.github.io/darkcode-orchestrator/

## 흐름
사용자 입력 → ai-router (분야 배정) → ai-music / ai-dev / ai-media / ai-qa (초안) → ai-critic (PASS / REVISE) → 반려 시 최대 1~3회 자동 수정 → 최종 출력 + 4줄 상태 압축

## 연결 (처음 한 번)
사이트의 [원클릭 연결] 버튼 → 받은 파일 더블클릭. 설치 확인, OLLAMA_ORIGINS 허용, Ollama 재시작, 없는 모델 생성, [Ollama 켜기] 버튼(darkcode-ollama://) 등록까지 자동.
- Windows 대체: Win+R → powershell -ExecutionPolicy Bypass -c "irm https://jake12733.github.io/darkcode-orchestrator/connect/win.txt|iex"
- Mac/Linux: curl -fsSL https://jake12733.github.io/darkcode-orchestrator/connect/unix.sh | sh

## 파일
- assets/orchestrator.js : 파이프라인 엔진 (UI 없이 DARK CODE 등 다른 화면에 그대로 재사용 가능)
- assets/app.js : 화면 동작
- assets/style.css : DARK CODE 블랙 + 네온 그린 테마
- connect/ : 원클릭 연결 스크립트 (win.txt, unix.sh, DARKCODE-Ollama-Connect.bat)
- models/ : DARK CODE Modelfile 6종 (연결 스크립트가 없는 모델 자동 생성에 사용)
