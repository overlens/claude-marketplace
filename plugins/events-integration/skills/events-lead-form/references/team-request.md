# Message for the Events team (pt-BR)

Fill in everything you already know from the repo and the conversation. Leave unknowns as
`[preencher: …]` so the user can complete them. Remove the Pixel section if there is no Pixel at
all. Give it to the user inside a fenced block so it can be copied as is.

```text
Oi, time do Events! Integrei o formulário da LP abaixo com o Events (SDK @overlens/events-sdk)
e preciso de algumas informações/configurações de vocês para ativar:

LP: [nome da LP / campanha]
Domínio(s) de produção: [https://… — inclua www e subdomínios que a LP realmente usa]
Formulários integrados: [ex.: hero e rodapé — campos enviados: e-mail, nome, telefone]
Destinos desejados para os leads: [ex.: Google Sheets, Brevo, ManyChat, Meta CAPI — ou "a definir"]

O que preciso de vocês:
1. A URL do trigger "Formulário de Lead" desse workflow
   (formato https://…/webhooks/leads/<slug>).
2. Cadastrar o(s) domínio(s) acima em Configurações → Formulário de Lead → Origens permitidas.
3. [Se houver Pixel] A LP tem Meta Pixel [no código da página | via GTM]. Qual nome de evento
   o nó Meta do workflow usa? A integração dispara "Lead" — se for outro nome, me avisem.

Assim que eu receber a URL, configuro a variável [NOME_DA_VARIAVEL] na hospedagem e faço o
redeploy. Depois faço um envio de teste para vocês confirmarem que o lead chegou.
```

## Notes for you (do not include in the message)

- Item 1 is the only value the code needs. Items 2 and 3 are configuration on the Events side.
- If the user does not know whom to contact, tell them to ask whoever manages the campaigns /
  Overlens tech team for "o time responsável pelo Events" — do not invent names or channels.
- If the Pixel fires through GTM and the LP already does a `dataLayer.push` for the lead, add a
  line to the message: "A LP já faz `dataLayer.push` do evento `<nome>`; querem que eu migre para
  o adaptador `dataLayer()` da SDK para deduplicar Pixel e CAPI?" — and do not migrate on your own.
