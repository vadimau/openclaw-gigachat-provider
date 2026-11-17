# Security

## Supported versions

| Version | Supported |
| --- | --- |
| 0.1.x | Yes |

## Reporting a vulnerability

Please open a private GitHub security advisory:

https://github.com/vadimau/openclaw-gigachat-provider/security/advisories/new

Do not post GigaChat authorization keys, Gateway tokens, or other secrets in a
public issue.

## Secret handling

- The plugin never ships or logs a GigaChat authorization key.
- The key is read from `plugins.entries.gigachat.config.authKey`,
  `clientId` + `clientSecret`, or the `GIGACHAT_AUTH_KEY` environment variable.
- The local bridge listens on `127.0.0.1` only and expects the configured
  `localToken` (default `gigachat-local`) as its Bearer token.
- The bundled `certs/` files are public Russian Trusted Root/Sub CA
  certificates published by the Ministry of Digital Development.
