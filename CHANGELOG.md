# Changelog

## 0.1.0 — 2026-11-17

Первый публичный релиз.

- Провайдер `gigachat` для OpenClaw с бесплатными моделями `GigaChat-3-Ultra`,
  `GigaChat-2-Max`, `GigaChat-2-Pro` и `GigaChat-2`.
- OAuth-токен GigaChat с автоматическим обновлением.
- TLS по сертификатам НУЦ Минцифры, bundled CA.
- Встроенный OpenAI-совместимый мост на `127.0.0.1:18080`.
- Поддержка tool calling: `tools` ⇄ `functions`, `tool_calls` ⇄ `function_call`, SSE.
- Нормализация JSON-схем инструментов под требования GigaChat.
- Очередь запросов для тарифа физлиц с одним потоком.
