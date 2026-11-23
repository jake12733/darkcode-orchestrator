# DARK CODE Orchestrator

로컬 Ollama 전문가 AI 6종을 자동 배정 → 초안 → 검수 → 수정 루프로 돌리는 멀티 에이전트 오케스트레이터.

Live: https://jake12733.github.io/darkcode-orchestrator/

## 흐름
사용자 입력 → ai-router (분야 배정) → ai-music / ai-dev / ai-media / ai-qa (초안) → ai-critic (PASS / REVISE) → 반려 시 최대 1~3회 자동 수정 → 최종 출력 + 4줄 상태 압축

## 준비 (처음 한 번)
1. Ollama 설치 후 setup-darkcode-ai.bat 실행 (모델 6개 생성)
2. cmd: setx OLLAMA_ORIGINS "https://jake12733.github.io"
3. Ollama 종료 후 다시 실행 → 페이지 새로고침

## 파일
- assets/orchestrator.js : 파이프라인 엔진 (UI 없이 DARK CODE 등 다른 화면에 그대로 재사용 가능)
- assets/app.js : 화면 동작
- assets/style.css : DARK CODE 블랙 + 네온 그린 테마
