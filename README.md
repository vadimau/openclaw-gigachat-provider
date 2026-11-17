# GigaChat Provider для OpenClaw

Плагин-провайдер `gigachat` для OpenClaw: подключает бесплатные модели GigaChat по тарифу
`GIGACHAT_API_PERS` и совместим с агентским режимом OpenClaw (вызов инструментов).

## Зачем нужен мост

GigaChat отдаёт OpenAI-совместимый API, но с тремя отличиями:

1. Авторизация не по статическому ключу, а по OAuth-токену на 30 минут
   (`https://ngw.devices.sberbank.ru:9443/api/v2/oauth`).
2. TLS-цепочка подписана сертификатами НУЦ Минцифры, которых нет в стандартном хранилище Node.
3. Инструменты и стрим используют старый формат `functions` / `function_call`, а аргументы
   функции приходят объектом, а не JSON-строкой.

Плагин поднимает локальный OpenAI-совместимый мост на `127.0.0.1:18080` и переводит запросы
туда и обратно:

```
OpenClaw ──OpenAI API──▶ 127.0.0.1:18080 ──GigaChat API──▶ api.giga.chat
                              │
                              ├─ OAuth-токен и его обновление
                              ├─ TLS по сертификатам Минцифры
                              ├─ tools ⇄ functions, tool_calls ⇄ function_call
                              └─ SSE-стрим в формате OpenAI
```

Мост работает только на loopback и не требует Python, gpt2giga или отдельных процессов.

## Модели

| Модель | ID | Контекст | Бесплатная квота |
| --- | --- | --- | --- |
| GigaChat 3 Ultra | `gigachat/GigaChat-3-Ultra` | 128 000 | 50 млн токенов |
| GigaChat 2 Max | `gigachat/GigaChat-2-Max` | 128 000 | 25 млн токенов |
| GigaChat 2 Pro | `gigachat/GigaChat-2-Pro` | 128 000 | 40 млн токенов |
| GigaChat 2 Lite | `gigachat/GigaChat-2` | 128 000 | 250 млн токенов |

Квоты действуют 12 месяцев с момента получения доступа (freemium для физлиц).

## Установка

Из ClawHub:

```powershell
openclaw plugins install clawhub:vadimau/openclaw-gigachat-provider
```

Из npm:

```powershell
openclaw plugins install npm:openclaw-gigachat-provider
```

Из GitHub:

```powershell
openclaw plugins install git:github.com/vadimau/openclaw-gigachat-provider@v0.1.0
```

Из локальной папки для разработки:

```powershell
openclaw plugins install --link "C:\Users\Vadim\Documents\MultiTool\Giga\gigachat-plugin" --accept-capabilities --force
```

Проверка:

```powershell
openclaw plugins inspect gigachat --runtime --json
Invoke-RestMethod http://127.0.0.1:18080/health
openclaw models list --provider gigachat --json
```

## Ключ доступа

Ключ берётся в личном кабинете [developers.sber.ru](https://developers.sber.ru/) после создания
приложения GigaChat API. Подходят оба варианта:

- готовая строка «Ключ авторизации» (Base64 от `Client ID:Client Secret`);
- пара `Client ID` и `Client Secret` — плагин сам закодирует их в Base64.

Ключ можно положить двумя способами.

### Вариант A: в настройки плагина (рекомендуется)

`~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "gigachat": {
        "enabled": true,
        "config": {
          "port": 18080,
          "localToken": "gigachat-local",
          "scope": "GIGACHAT_API_PERS",
          "authKey": "ВАШ_КЛЮЧ_АВТОРИЗАЦИИ"
        }
      }
    }
  }
}
```

Вместо `authKey` можно указать `clientId` и `clientSecret`.

### Вариант B: напрямую в провайдере

```json
{
  "models": {
    "providers": {
      "gigachat": {
        "baseUrl": "http://127.0.0.1:18080/v1",
        "api": "openai-completions",
        "apiKey": "ВАШ_КЛЮЧ_АВТОРИЗАЦИИ",
        "timeoutSeconds": 300,
        "models": [
          { "id": "GigaChat-3-Ultra", "name": "GigaChat 3 Ultra" }
        ]
      }
    }
  }
}
```

Если ключ лежит в `models.providers.gigachat.apiKey`, `plugins.entries.gigachat.config.authKey`
не нужен: мост использует входящий Bearer-токен как ключ GigaChat.

### Переменные окружения

Если удобнее хранить секрет вне конфига:

- `GIGACHAT_AUTH_KEY` — ключ авторизации;
- `GIGACHAT_CLIENT_ID` и `GIGACHAT_CLIENT_SECRET` — пара клиента;
- `GIGACHAT_SCOPE` — по умолчанию `GIGACHAT_API_PERS`;
- `GIGACHAT_BRIDGE_PORT` — порт моста;
- `GIGACHAT_CA_FILE` — дополнительный CA-bundle;
- `GIGACHAT_INSECURE_TLS=1` — отключить проверку TLS (только для отладки).

## Выбор модели

Для отдельного агента:

```json
{
  "agents": {
    "list": [
      {
        "id": "ruslan",
        "name": "Ruslan",
        "model": "gigachat/GigaChat-2-Pro",
        "workspace": "C:\\Users\\Vadim\\.openclaw\\agents\\ruslan\\workspace"
      }
    ]
  }
}
```

Или переключить основную модель:

```powershell
openclaw models set gigachat/GigaChat-3-Ultra
```

## Проверка без OpenClaw

```powershell
$headers = @{ Authorization = "Bearer ВАШ_КЛЮЧ_АВТОРИЗАЦИИ"; "Content-Type" = "application/json" }
$body = @{
  model = "GigaChat-2"
  messages = @(@{ role = "user"; content = "Столица России?" })
  stream = $false
} | ConvertTo-Json -Depth 5
Invoke-RestMethod -Uri "http://127.0.0.1:18080/v1/chat/completions" -Method Post -Headers $headers -Body $body
```

Ожидаемый ответ — JSON в формате OpenAI с `choices[0].message.content = "Москва"`.

## Ограничения

- Поддерживается только текст. Изображения и аудио пока не передаются в GigaChat.
- У физлиц доступен один поток, поэтому мост ставит запросы в очередь по ключу.
- Параллельные вызовы инструментов не поддерживаются: GigaChat v1 принимает один
  `function_call` за сообщение. При нескольких `tool_calls` мост разворачивает их в
  последовательные сообщения.
- История вызовов инструментов хранит `functions_state_id` в памяти процесса. После
  перезапуска Gateway старые tool-call сообщения могут потерять состояние; новые
  запросы продолжают работать.

## Диагностика

| Симптом | Причина и решение |
| --- | --- |
| `401 Unauthorized` | Неверный или просроченный ключ. Проверьте `authKey` / `apiKey`, scope `GIGACHAT_API_PERS`. |
| `402 Payment Required` | Бесплатная квота исчерпана. Нужен платный пакет или другой аккаунт. |
| `429 Too Many Requests` | Превышен лимит потоков (у физлиц — один). Мост уже сериализует запросы; проверьте другие процессы. |
| `422 Invalid params: system message must be the first message` | В истории несколько системных сообщений. Плагин склеивает их в одно; сообщите, если ошибка повторяется. |
| `EADDRINUSE` | Порт 18080 занят. Измените `plugins.entries.gigachat.config.port` и `models.providers.gigachat.baseUrl`. |
| `CERTIFICATE_VERIFY_FAILED` | Не загрузился CA Минцифры. Проверьте папку `certs/`, при необходимости задайте `caFile`. |
| Инструменты не вызываются | Проверьте `compat.supportsTools: true` у моделей и что модель поддерживает функции (все четыре поддерживают). |

Логи моста пишутся в лог плагина с префиксом `[gigachat]`.

## Файлы

```
gigachat-plugin/
├── index.js                 # регистрация провайдера и сервиса
├── openclaw.plugin.json     # манифест, модели, схема настроек
├── package.json
├── lib/
│   ├── credentials.js       # OAuth-токен, TLS, HTTP-запросы
│   ├── gigachat.js          # клиент GigaChat
│   ├── models.js            # список бесплатных моделей
│   ├── server.js            # локальный OpenAI-совместимый мост
│   ├── settings.js          # настройки плагина
│   └── transform.js         # tools ⇄ functions и SSE
├── certs/                   # Russian Trusted Root CA и Sub CA
└── test/                    # тесты преобразований и моста
```

Запуск тестов:

```powershell
cd C:\Users\Vadim\Documents\MultiTool\Giga\gigachat-plugin
node --test test\transform.test.js test\bridge.test.js
```
