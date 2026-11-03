# Cadastro de usuário por serviço

`POST /users` recebe um token `client_credentials` com o scope dedicado
`users:create`. O scope deve ser concedido explicitamente ao cliente de pagamentos.
`profile:read` sozinho não autoriza essa operação. A autenticação usa o mesmo
`M2MAuthGuard` do endpoint de leitura: Bearer RS256 com issuer, audience e claims
`client_id`/`scope` válidos. Cookies e tokens de usuário não autorizam o cadastro.

```json
{ "email": "comprador@example.com", "name": "Nome do comprador" }
```

`email` é obrigatório e normalizado; `name` é opcional. A resposta `200` contém
`{ "profile": <perfil M2M>, "created": true | false }`. O `profile.sub` é o identificador
canônico para criar o espelho e associar compras no aplicativo consumidor. A resposta
nunca contém senha, token de recuperação, cookie ou token de sessão.

Uma identidade existente mantém nome, credenciais, verificação de e-mail e papel.
Uma identidade criada nasce com hash de senha aleatória forte e `emailVerified=false`.
A senha não é retornada nem enviada; o fluxo de recuperação envia um link para o comprador
definir a própria senha,
respeitando as cotas por destinatário. O consumidor pode enviar seu próprio e-mail de
boas-vindas depois de persistir o espelho e o acesso comprado.

Contas bloqueadas, desativadas ou excluídas retornam `403`. Dados inválidos retornam
`400`. Os erros de autenticação, autorização e entrada seguem o corpo M2M
`{ error, error_description }`:

| HTTP | `error` | Motivo |
| --- | --- | --- |
| `400` | `invalid_request` | E-mail ou nome inválidos |
| `401` | `invalid_token` | Bearer ausente, inválido, expirado ou token de usuário |
| `403` | `insufficient_scope` | Ausência de `users:create` |
| `403` | `access_denied` | Conta bloqueada, desativada ou excluída |
| `429` | — | Limite de 60 requisições por minuto por client |

O perfil `m2m-user-create` usa o `ClientThrottlerGuard` e o storage centralizado.
Um `429` inclui `Retry-After`; outros clients e a leitura de perfil mantêm suas cotas.
A resposta de cadastro envia `Cache-Control: private, no-store` e não cria sessão
nem emite cookies. Logs estruturados contêm `clientId`, `sub`, `created`, IP e
timestamp, sem e-mail, corpo da requisição ou credenciais. A criação é
idempotente por e-mail, inclusive sob concorrência. Falhas de infraestrutura devem
ser tratadas como tentativas incompletas pelo consumidor e podem ser reenviadas.

Publicar a operação no IDP antes de habilitar o cadastro de usuários no serviço consumidor.
Nenhum cliente ganha o novo scope automaticamente. Esta rota não registra aceite de
termos de outro aplicativo: consentimento continua sendo uma ação explícita do usuário.
